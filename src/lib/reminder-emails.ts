import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule, parseTimeToMins, type WeeklySession } from "@/lib/sheets";
import { normalizeDate } from "@/lib/calendar";
import { canonicalGroupForLabel } from "@/lib/group-matching";
import { sendReminderEmail, sendReminderEmailAdminSummary } from "@/lib/email";
import type { Athlete, CanonicalGroupId } from "@/lib/athletes";

export type ReminderWindow = "morning" | "evening";

const NOON_MINS = 12 * 60;

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

// "Today"/"tomorrow" are always evaluated in the business's own timezone,
// not the server's — same en-CA Intl pattern already used in calendar.ts.
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function tomorrowET(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

interface SessionGroup {
  group: string;
  dateLabel: string;
  timeLabel: string;
  location: string;
  athleteNames: string[];
}

// Core logic shared by both cron routes. Reads each athlete's PERSISTED
// `groups` assignment (never recomputed live from grade/gender) against
// whichever canonical groups have a session in this window — see
// src/lib/group-matching.ts for how bookings/backfill/admin edits keep that
// assignment up to date. dryRun skips the claim-lock and the actual sends,
// returning the computed match list instead, so the owner can sanity-check
// a real day's output before trusting the unattended schedule.
export async function runReminderEmailWindow(window: ReminderWindow, options?: { dryRun?: boolean }) {
  const today = todayET();
  const targetDate = window === "morning" ? today : tomorrowET();
  const runKey = `${today}-${window}`;
  // Every session considered in a single run shares this one target date
  // (see the windowSessions filter below), so a single TODAY/TOMORROW
  // badge for the whole email is always accurate — never per-session.
  const isToday = window === "morning";

  const supabase = getSupabaseAdmin();

  if (!options?.dryRun) {
    // Claim BEFORE sending anything — run_key is the primary key, so an
    // overlapping invocation (retry, manual re-trigger) fails to insert and
    // skips the whole blast instead of double-emailing everyone.
    const { error: claimError } = await supabase.from("reminder_email_runs").insert({ run_key: runKey });
    if (claimError) {
      return { skipped: true, reason: "Already ran for this window", runKey, window, targetDate };
    }
  }

  const schedule = await getWeeklySchedule({ noCache: true });
  const sessionsOnTargetDate = schedule.filter((s) => normalizeDate(s.date) === targetDate);
  const windowSessions = sessionsOnTargetDate.filter((s) => {
    const startMins = parseTimeToMins(s.startTime);
    return window === "morning" ? startMins >= NOON_MINS : startMins < NOON_MINS;
  });

  const groupToSessions = new Map<CanonicalGroupId, WeeklySession[]>();
  for (const s of windowSessions) {
    const cg = canonicalGroupForLabel(s.group);
    if (!cg) continue;
    if (!groupToSessions.has(cg)) groupToSessions.set(cg, []);
    groupToSessions.get(cg)!.push(s);
  }

  // Session-first, not athlete-first: two siblings matching the exact same
  // session collapse into one card listing both names, instead of two
  // near-identical cards repeating the same group/date/time/location — the
  // whole point being less to read, so it reads as more urgent, not less.
  const sessionKey = (s: WeeklySession) => `${s.group}|${s.date}|${s.startTime}|${s.endTime}|${s.location}`;
  const byEmail = new Map<string, { parentName: string; sessionsByKey: Map<string, SessionGroup> }>();

  if (groupToSessions.size > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("email, parent_name, kids")
      .eq("reminder_emails", true);
    if (profilesError) throw new Error(profilesError.message);

    for (const p of profiles || []) {
      if (!p.email || !Array.isArray(p.kids)) continue;
      for (const kid of p.kids as Athlete[]) {
        if (!kid.name || !kid.groups?.length) continue;
        for (const g of kid.groups) {
          const sessions = groupToSessions.get(g);
          if (!sessions) continue;
          for (const s of sessions) {
            if (!byEmail.has(p.email)) byEmail.set(p.email, { parentName: p.parent_name || "", sessionsByKey: new Map() });
            const parentEntry = byEmail.get(p.email)!;
            const key = sessionKey(s);
            if (!parentEntry.sessionsByKey.has(key)) {
              parentEntry.sessionsByKey.set(key, {
                group: s.group,
                dateLabel: formatDateLabel(normalizeDate(s.date)),
                timeLabel: s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime,
                location: s.location,
                athleteNames: [],
              });
            }
            const sessionGroup = parentEntry.sessionsByKey.get(key)!;
            if (!sessionGroup.athleteNames.includes(kid.name)) sessionGroup.athleteNames.push(kid.name);
          }
        }
      }
    }
  }

  let emailsSent = 0;
  if (!options?.dryRun) {
    const sentSummary: { email: string; parentName: string; sessions: SessionGroup[] }[] = [];
    const failedEmails: string[] = [];

    for (const [email, { parentName, sessionsByKey }] of byEmail) {
      const sessions = Array.from(sessionsByKey.values());
      try {
        await sendReminderEmail({ to: email, parentName, isToday, sessions });
        emailsSent++;
        sentSummary.push({ email, parentName, sessions });
      } catch (err) {
        console.error(`Reminder email failed for ${email}:`, err);
        failedEmails.push(email);
      }
    }
    await supabase.from("reminder_email_runs").update({ emails_sent: emailsSent }).eq("run_key", runKey);

    // One consolidated summary to Artemios per run (not a per-parent BCC —
    // with 10-15+ matches that would flood his inbox) so he can confirm a
    // run actually fired without digging through logs, and see any real
    // send failures at a glance.
    try {
      await sendReminderEmailAdminSummary({
        window,
        targetDate,
        sessionsInWindow: windowSessions.length,
        parents: sentSummary,
        failedEmails,
      });
    } catch (err) {
      console.error("Reminder email admin summary failed:", err);
    }
  }

  return {
    runKey,
    window,
    targetDate,
    sessionsInWindow: windowSessions.length,
    parentsMatched: byEmail.size,
    emailsSent,
    matches: options?.dryRun
      ? Array.from(byEmail.entries()).map(([email, v]) => ({
          email,
          parentName: v.parentName,
          sessions: Array.from(v.sessionsByKey.values()),
        }))
      : undefined,
  };
}
