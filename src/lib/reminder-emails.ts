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

interface Match {
  email: string;
  parentName: string;
  athleteName: string;
  sessions: WeeklySession[];
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

  const matches: Match[] = [];
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
        const matchedSessions: WeeklySession[] = [];
        for (const g of kid.groups) {
          const sessions = groupToSessions.get(g);
          if (sessions) matchedSessions.push(...sessions);
        }
        if (matchedSessions.length === 0) continue;
        matches.push({ email: p.email, parentName: p.parent_name || "", athleteName: kid.name, sessions: matchedSessions });
      }
    }
  }

  // One email per parent, even when several of their athletes each matched
  // a different session.
  const byEmail = new Map<string, { parentName: string; athletes: { athleteName: string; sessions: WeeklySession[] }[] }>();
  for (const m of matches) {
    if (!byEmail.has(m.email)) byEmail.set(m.email, { parentName: m.parentName, athletes: [] });
    byEmail.get(m.email)!.athletes.push({ athleteName: m.athleteName, sessions: m.sessions });
  }

  let emailsSent = 0;
  if (!options?.dryRun) {
    const sentSummary: { email: string; parentName: string; athletes: { athleteName: string; sessions: { group: string; dateLabel: string; timeLabel: string; location: string }[] }[] }[] = [];
    const failedEmails: string[] = [];

    for (const [email, { parentName, athletes }] of byEmail) {
      const formattedAthletes = athletes.map((a) => ({
        athleteName: a.athleteName,
        sessions: a.sessions.map((s) => ({
          group: s.group,
          dateLabel: formatDateLabel(normalizeDate(s.date)),
          timeLabel: s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime,
          location: s.location,
        })),
      }));
      try {
        await sendReminderEmail({ to: email, parentName, athletes: formattedAthletes });
        emailsSent++;
        sentSummary.push({ email, parentName, athletes: formattedAthletes });
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
          athletes: v.athletes.map((a) => ({
            name: a.athleteName,
            sessions: a.sessions.map((s) => ({ group: s.group, date: s.date, startTime: s.startTime, endTime: s.endTime, location: s.location })),
          })),
        }))
      : undefined,
  };
}
