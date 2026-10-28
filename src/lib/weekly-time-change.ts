import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklySession } from "@/lib/sheets";
import type { WeeklyRegKeyFields } from "@/lib/weekly-schedule-matching";
import { sendTimeChangeNotification } from "@/lib/email";
import { sendSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { notifyTrainerOfReschedule } from "@/lib/trainer-notify";
import { normalizeTrainerNameForComparison } from "@/lib/trainers";

export interface WeeklyChangeReg extends WeeklyRegKeyFields {
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  sms_consent: boolean | null;
  booked_trainer: string | null;
}

export interface AppliedSessionChange<T> {
  session: WeeklySession;
  oldStart: string;
  oldEnd: string;
  oldLocation: string;
  timeChanged: boolean;
  locationChanged: boolean;
  regs: T[]; // the registrations this run actually moved (and notified)
}

// Applies buildWeeklyPlan's time/location changes: moves every booked
// player of a session to its new time/location, then tells each of them
// (email, and a text if they opted in) and the session's trainer.
//
// The move is ONE conditional UPDATE per session (per distinct old
// time/location within it), never one player at a time. Moving players one
// by one is what once got a player cancelled: a second sync running before
// the first finished saw some players already at the new time and the rest
// still at the old one, and read the leftovers as a deleted session. With a
// single statement every reader sees either all of a session's players at
// the old time or all at the new one. The statement is conditional on the
// old values, so when the sheet-edit cron and the dashboard sync race, only
// the one whose UPDATE lands first moves (and notifies) anyone; the other
// matches zero rows and sends nothing.
//
// Shared by the detect-time-changes cron and the admin dashboard sync, so
// the two can't drift apart.
export async function applyWeeklyTimeChanges<T extends WeeklyChangeReg>(
  supabase: SupabaseClient,
  changes: { reg: T; newSession: WeeklySession }[]
): Promise<{ sessions: AppliedSessionChange<T>[]; emailsSent: number; smsSent: number }> {
  const bySession = new Map<string, { session: WeeklySession; regs: T[] }>();
  for (const { reg, newSession } of changes) {
    const key = `${newSession.date}|${newSession.group}|${newSession.startTime}|${newSession.endTime}|${newSession.location}`;
    if (!bySession.has(key)) bySession.set(key, { session: newSession, regs: [] });
    bySession.get(key)!.regs.push(reg);
  }

  const sessions: AppliedSessionChange<T>[] = [];
  let emailsSent = 0;
  let smsSent = 0;

  for (const { session, regs } of bySession.values()) {
    // Players of one session normally share the same stored time and
    // location; group by them anyway so each UPDATE's "old values" condition
    // is exact for every row in it.
    const byOld = new Map<string, T[]>();
    for (const r of regs) {
      const k = `${r.booked_start_time}|${r.booked_end_time ?? ""}|${r.booked_location ?? ""}`;
      if (!byOld.has(k)) byOld.set(k, []);
      byOld.get(k)!.push(r);
    }

    for (const group of byOld.values()) {
      const sample = group[0];
      const oldStart = sample.booked_start_time;
      const oldEnd = sample.booked_end_time || oldStart;
      const oldLocation = sample.booked_location || "";
      const timeChanged = sample.booked_start_time !== session.startTime || sample.booked_end_time !== session.endTime;
      const locationChanged = sample.booked_location !== session.location;

      let query = supabase
        .from("registrations")
        .update({
          booked_start_time: session.startTime,
          booked_end_time: session.endTime,
          ...(locationChanged ? { booked_location: session.location } : {}),
          admin_change_at: new Date().toISOString(),
        })
        .in("id", group.map((r) => r.id))
        .eq("status", "confirmed")
        .eq("booked_start_time", sample.booked_start_time);
      query = sample.booked_end_time === null ? query.is("booked_end_time", null) : query.eq("booked_end_time", sample.booked_end_time);
      query = sample.booked_location === null ? query.is("booked_location", null) : query.eq("booked_location", sample.booked_location);
      const { data: wonRows, error } = await query.select("id");
      if (error) {
        console.error("Weekly time-change move failed:", error);
        continue;
      }
      const wonIds = new Set((wonRows || []).map((w: { id: string }) => w.id));
      const won = group.filter((r) => wonIds.has(r.id));
      if (won.length === 0) continue; // the other sync already moved and notified these

      // The display string, per player (it can differ in wording). Written
      // right after the move, before the slower notifications below.
      for (const r of won) {
        let details = r.session_details || "";
        if (timeChanged) {
          details = details
            .replace(`${oldStart}-${oldEnd}`, `${session.startTime}-${session.endTime}`)
            .replace(`${oldStart}–${oldEnd}`, `${session.startTime}–${session.endTime}`);
        }
        if (locationChanged && oldLocation) details = details.replace(`at ${oldLocation}`, `at ${session.location}`);
        if (details !== (r.session_details || "")) {
          const { error: detailsError } = await supabase.from("registrations").update({ session_details: details }).eq("id", r.id);
          if (detailsError) console.error("Weekly time-change details update failed for", r.id, detailsError);
        }
      }

      const changeType: "time" | "location" | "both" = timeChanged && locationChanged ? "both" : timeChanged ? "time" : "location";
      for (const r of won) {
        try {
          await sendTimeChangeNotification({
            parentName: r.parent_name,
            email: r.email,
            kids: r.kids,
            date: session.date,
            sessionLabel: session.group,
            oldStartTime: oldStart,
            oldEndTime: oldEnd,
            newStartTime: session.startTime,
            newEndTime: session.endTime,
            location: session.location,
            changeType,
            oldLocation: locationChanged ? oldLocation : undefined,
          });
          emailsSent++;
        } catch (err) {
          console.error("Change notification email failed for", r.email, err);
        }

        if (r.sms_consent && r.phone) {
          const dateStr = formatDateWithDay(session.date);
          const locName = resolveLocationName(session.location);
          const oldLocName = resolveLocationName(oldLocation);
          let smsBody: string;
          if (changeType === "both") {
            smsBody = `TIME & LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${oldStart}-${oldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${oldLocName} → ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
          } else if (changeType === "time") {
            smsBody = `TIME CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${oldStart}-${oldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
          } else {
            smsBody = `LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nLocation: ${oldLocName} → ${locName}\nTime: ${session.startTime}-${session.endTime}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
          }
          try {
            await sendSMS(r.phone, smsBody);
            smsSent++;
          } catch (err) {
            console.error("Change notification SMS failed for", r.phone, err);
          }
        }
      }

      // The trainer running it (the sheet's), and the one the players were
      // booked with if that's someone else: one message per session listing
      // the players, not one per player.
      const players = won.map((r) => r.kids || r.parent_name).join(", ");
      const trainers = new Map<string, string>();
      for (const t of [session.trainer || "Artemios Gavalas", ...won.map((r) => r.booked_trainer || "Artemios Gavalas")]) {
        trainers.set(normalizeTrainerNameForComparison(t), t);
      }
      for (const trainer of trainers.values()) {
        await notifyTrainerOfReschedule({
          trainer,
          parentName: `${won.length} player${won.length !== 1 ? "s" : ""} (${players})`,
          sessionLabel: session.group,
          oldDate: session.date,
          oldStartTime: oldStart,
          oldEndTime: oldEnd,
          newDate: session.date,
          newStartTime: session.startTime,
          newEndTime: session.endTime,
          location: locationChanged ? `${resolveLocationName(session.location)} (was ${resolveLocationName(oldLocation)})` : session.location,
        }).catch((err) => console.error("Trainer time-change notify failed:", err));
      }

      sessions.push({ session, oldStart, oldEnd, oldLocation, timeChanged, locationChanged, regs: won });
    }
  }

  return { sessions, emailsSent, smsSent };
}
