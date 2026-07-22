import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import { getWeeklySchedule } from "@/lib/sheets";
import { sendTimeChangeNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { buildWeeklyPlan, claimWeeklyTimeChange, type WeeklyRegKeyFields } from "@/lib/weekly-schedule-matching";


interface WeeklyRegistration extends WeeklyRegKeyFields {
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  sms_consent: boolean;
}

function sessionIsUpcoming(dateStr: string, startTimeStr: string): boolean {
  try {
    const now = new Date();
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const getP = (t: string) => etParts.find((p) => p.type === t)?.value ?? "0";
    const todayISO = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const nowMinutes = parseInt(getP("hour")) * 60 + parseInt(getP("minute"));

    const sd = new Date(dateStr);
    if (isNaN(sd.getTime())) return true;
    const sessionISO = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, "0")}-${String(sd.getDate()).padStart(2, "0")}`;

    if (sessionISO > todayISO) return true;
    if (sessionISO < todayISO) return false;

    const match = startTimeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return true;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + m > nowMinutes;
  } catch {
    return true;
  }
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let sessions;
  try {
    sessions = await getWeeklySchedule({ noCache: true });
  } catch (err) {
    console.error("sync-time-changes: failed to fetch schedule", err);
    return NextResponse.json({ error: "Could not load schedule from Google Sheets." }, { status: 500 });
  }

  const upcoming = sessions.filter((s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group);

  const changesFound: { session: string; oldTime: string; newTime: string; count: number }[] = [];
  let totalEmailsSent = 0;
  let totalSmsSent = 0;

  // Fetch all candidate registrations in one query instead of one query per
  // upcoming session (this loop can run 200+ times, which turned into 200+
  // sequential round-trips).
  const uniqueDates = [...new Set(upcoming.map((s) => s.date))];
  let candidateRegs: WeeklyRegistration[] = [];
  if (uniqueDates.length) {
    const { data, error: candidateError } = await supabase
      .from("registrations")
      .select("*")
      .eq("type", "weekly")
      .eq("status", "confirmed")
      .in("booked_date", uniqueDates);
    if (candidateError) {
      console.error("sync-time-changes: failed to fetch candidate registrations", candidateError);
    } else {
      candidateRegs = data || [];
    }
  }

  // Bucket-matches by exact booked_group (falling back to session_details
  // parsing only for legacy rows) instead of a plain substring check, and
  // is aware of a group name running twice on the same day at different
  // times — same matching logic the detect-time-changes cron uses, shared
  // via src/lib/weekly-schedule-matching.ts so the two never drift apart
  // again (they already did once: this route was still doing a substring
  // match on session_details after the cron was fixed to use exact
  // booked_group matching).
  // plan.deletions/plan.ambiguous are intentionally unused here — this
  // route only ever synced time/location changes, never cancellations, and
  // the detect-time-changes cron already sends its own admin alert for any
  // ambiguous case, so duplicating that alert on every dashboard load would
  // just be noise.
  const plan = buildWeeklyPlan(upcoming, candidateRegs);

  const changesBySession = new Map<string, { session: (typeof upcoming)[number]; regs: WeeklyRegistration[] }>();
  for (const { reg, newSession } of plan.changes) {
    const key = `${newSession.date}|${newSession.group}|${newSession.startTime}|${newSession.endTime}|${newSession.location}`;
    if (!changesBySession.has(key)) changesBySession.set(key, { session: newSession, regs: [] });
    changesBySession.get(key)!.regs.push(reg);
  }

  for (const { session, regs: stale } of changesBySession.values()) {
    const oldStartTime: string = stale[0].booked_start_time;
    const oldEndTime: string = stale[0].booked_end_time || oldStartTime;

    changesFound.push({
      session: `${session.date} — ${session.group}`,
      oldTime: `${oldStartTime}–${oldEndTime}`,
      newTime: `${session.startTime}–${session.endTime}`,
      count: stale.length,
    });

    for (const r of stale) {
      const timeChanged = r.booked_start_time !== session.startTime || r.booked_end_time !== session.endTime;
      const locationChanged = r.booked_location !== session.location;
      const changeType: "time" | "location" | "both" =
        timeChanged && locationChanged ? "both" : timeChanged ? "time" : "location";

      const rOldStart: string = r.booked_start_time;
      const rOldEnd: string = r.booked_end_time || rOldStart;
      const rOldLocation: string = r.booked_location || "";

      let newDetails = r.session_details || "";
      if (timeChanged) {
        newDetails = newDetails
          .replace(`${rOldStart}-${rOldEnd}`, `${session.startTime}-${session.endTime}`)
          .replace(`${rOldStart}–${rOldEnd}`, `${session.startTime}–${session.endTime}`);
      }
      if (locationChanged && rOldLocation) {
        newDetails = newDetails.replace(`at ${rOldLocation}`, `at ${session.location}`);
      }

      // The detect-time-changes cron watches for the exact same changes
      // independently (fires on every sheet edit, this route fires on every
      // admin dashboard load) — conditioning the update on the OLD values
      // still matching means whichever of the two "wins" the race is the
      // only one that proceeds to notify the client below.
      const won = await claimWeeklyTimeChange(supabase, r, {
        booked_start_time: session.startTime,
        booked_end_time: session.endTime,
        ...(locationChanged ? { booked_location: session.location } : {}),
        session_details: newDetails,
      });
      if (!won) continue; // the cron already caught and notified this one

      try {
        await sendTimeChangeNotification({
          parentName: r.parent_name,
          email: r.email,
          kids: r.kids,
          date: session.date,
          sessionLabel: session.group,
          oldStartTime: rOldStart,
          oldEndTime: rOldEnd,
          newStartTime: session.startTime,
          newEndTime: session.endTime,
          location: session.location,
          changeType,
          oldLocation: locationChanged ? rOldLocation : undefined,
        });
        totalEmailsSent++;
      } catch (err) {
        console.error("Change notification email failed for", r.email, err);
      }

      if (r.sms_consent) {
        const dateStr = formatDateWithDay(session.date);
        const locName = resolveLocationName(session.location);
        let smsBody: string;
        const oldLocName = resolveLocationName(rOldLocation);
        if (changeType === "both") {
          smsBody = `TIME & LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${oldLocName} → ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else if (changeType === "time") {
          smsBody = `TIME CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else {
          smsBody = `LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nLocation: ${oldLocName} → ${locName}\nTime: ${session.startTime}-${session.endTime}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        }
        try {
          await sendSMS(r.phone, smsBody);
          totalSmsSent++;
        } catch (err) {
          console.error("Change notification SMS failed for", r.phone, err);
        }
      }
    }
  }

  if (changesFound.length > 0) {
    const summary = changesFound
      .map((c) => `• ${c.session}: ${c.oldTime} → ${c.newTime} (${c.count} registrant${c.count !== 1 ? "s" : ""})`)
      .join("\n");
    await sendAdminSMS(
      `TIME CHANGES SYNCED:\n${summary}\n${totalEmailsSent} email${totalEmailsSent !== 1 ? "s" : ""}, ${totalSmsSent} SMS sent`
    );
  }

  return NextResponse.json({
    success: true,
    changesFound,
    totalEmailsSent,
    totalSmsSent,
  });
}
