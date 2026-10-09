import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule, type WeeklySession } from "@/lib/sheets";
import { normalizeDate } from "@/lib/calendar";
import { canonicalGroupForLabel, CANONICAL_GROUPS } from "@/lib/group-matching";
import { regGroupKey } from "@/lib/weekly-schedule-matching";
import { sendSMS, resolveLocationName } from "@/lib/sms";
import type { Athlete, CanonicalGroupId } from "@/lib/athletes";

// Manual "spots open" text blast for one chosen day.
//
// This is the SMS twin of the automatic daily reminder email
// (src/lib/reminder-emails.ts) and deliberately reuses its matching rules:
// an athlete's PERSISTED `groups` assignment against whichever canonical
// groups actually have a session that day, with anyone already booked into
// that exact session left out. Two things differ, both on purpose:
//
//   1. The date is whatever Artemios picks, not today/tomorrow, and the
//      whole day is covered rather than a morning/evening half — this is
//      for quiet days he spots in advance, not a daily drumbeat.
//   2. It NEVER runs on a schedule. There is no cron entry for it and no
//      unattended caller; it only fires from the admin dashboard button,
//      after an explicit confirm.
//
// Consent lives on registrations (phone + sms_consent), groups live on
// profiles (kids + their groups), so a recipient has to exist in both and
// is matched between them on email.

// Deliberately the branded domain rather than NEXT_PUBLIC_BASE_URL: that
// env var points at the raw Vercel hostname in some environments, which is
// fine inside an email link but looks like spam in a text message.
const SITE = "mesabasketballtraining.com";

function getSupabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

/** Same digits-only comparison the weekly SMS cron uses, so the same real
 *  number stored in two different formats still counts as one person. */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "Fri, Oct 10" — the compact form, for inside a text. */
function formatShortDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export interface BlastSession {
  group: string;
  timeLabel: string;
  location: string;
  athleteNames: string[];
}

export interface BlastRecipient {
  email: string;
  parentName: string;
  phone: string;
  sessions: BlastSession[];
  message: string;
}

export interface BlastPreview {
  targetDate: string;
  dateLabel: string;
  sessionsOnDate: number;
  groupsOnDate: string[];
  recipients: BlastRecipient[];
  /** Matched on groups but has no opted-in phone — they'd still get the email. */
  skippedNoConsent: { email: string; parentName: string; reason: "no phone on file" | "not opted in to texts" }[];
  /** Matched but already booked into every session they'd be told about. */
  skippedAlreadyBooked: number;
  previousSends: { sentAt: string; textsSent: number }[];
}

// A combo session's raw sheet label ("JV & Varsity Boys") shouldn't be what
// a JV-only family reads, same reasoning as the email path.
function displayGroupLabel(matched: Set<CanonicalGroupId>, rawGroup: string): string {
  const labels = CANONICAL_GROUPS.filter((cg) => matched.has(cg.id)).map((cg) => cg.label);
  return labels.length > 0 ? labels.join(" & ") : rawGroup;
}

/** The actual text. Kept tight (this lands on a phone, not an inbox) and
 *  deliberately plain ASCII: a single curly dash or middle dot would push
 *  Twilio from GSM-7 into UCS-2, which drops a segment from 160 characters
 *  to 67 and roughly triples what every send costs. */
export function buildBlastMessage(isoDate: string, sessions: BlastSession[]): string {
  const when = formatShortDate(isoDate);
  const kids = Array.from(new Set(sessions.flatMap((s) => s.athleteNames)));
  const who = kids.length === 0
    ? ""
    : kids.length === 1
      ? ` for ${kids[0]}`
      : ` for ${kids.slice(0, -1).join(", ")} & ${kids[kids.length - 1]}`;

  // One text per client, always — but Twilio bills per 160-character
  // SEGMENT, not per send, so a parent with four matching sessions would
  // quietly cost three times what a parent with one costs. Listing two and
  // counting the rest keeps nearly every message to one or two segments
  // while still naming a time and place they can act on.
  const MAX_LISTED = 2;
  const lines = sessions
    .slice(0, MAX_LISTED)
    .map((s) => `${s.group} - ${s.timeLabel} - ${resolveLocationName(s.location)}`);
  const extra = sessions.length - MAX_LISTED;
  if (extra > 0) lines.push(`+${extra} more session${extra === 1 ? "" : "s"} that day`);

  return [
    `Mesa Basketball: SPOTS STILL OPEN ${when}${who}.`,
    ...lines,
    `Book: ${SITE}`,
    "Reply STOP to opt out.",
  ].join("\n");
}

/**
 * Work out exactly who would be texted for one date, and what each of them
 * would receive. Sends nothing. This is what the dashboard shows before
 * anything leaves the building.
 */
export async function computeGroupBlast(targetDate: string): Promise<BlastPreview> {
  const supabase = getSupabaseAdmin();
  const dateLabel = formatDateLabel(targetDate);

  const schedule = await getWeeklySchedule({ noCache: true });
  const sessionsOnDate = schedule.filter((s) => normalizeDate(s.date) === targetDate);

  const groupToSessions = new Map<CanonicalGroupId, WeeklySession[]>();
  for (const s of sessionsOnDate) {
    for (const cg of canonicalGroupForLabel(s.group)) {
      if (!groupToSessions.has(cg)) groupToSessions.set(cg, []);
      groupToSessions.get(cg)!.push(s);
    }
  }

  const previousSends = await readPreviousSends(supabase, targetDate);

  const empty: BlastPreview = {
    targetDate,
    dateLabel,
    sessionsOnDate: sessionsOnDate.length,
    groupsOnDate: Array.from(new Set(sessionsOnDate.map((s) => s.group))),
    recipients: [],
    skippedNoConsent: [],
    skippedAlreadyBooked: 0,
    previousSends,
  };
  if (groupToSessions.size === 0) return empty;

  // Already-booked exclusion, same shape as the email path: booked_date is
  // stored in whatever format the sheet exported, so filter broadly in SQL
  // and compare in JS rather than an exact-string .eq() that would silently
  // match nothing.
  const groupNames = Array.from(new Set(sessionsOnDate.map((s) => s.group)));
  const { data: existingRegs } = await supabase
    .from("registrations")
    .select("email, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, session_details")
    .eq("status", "confirmed")
    .in("booked_group", groupNames);

  const alreadyBookedKeys = new Set<string>();
  for (const r of existingRegs || []) {
    if (!r.email || !r.booked_date) continue;
    if (normalizeDate(r.booked_date) !== targetDate) continue;
    const group = regGroupKey(r);
    if (!group) continue;
    alreadyBookedKeys.add(
      `${r.email.toLowerCase().trim()}|${group}|${targetDate}|${r.booked_start_time}|${r.booked_end_time || ""}|${r.booked_location || ""}`
    );
  }

  // Consent + phone, newest row per email wins. sms_consent is captured per
  // registration, so a client who later opted out on a newer booking must
  // not be texted off the back of an older row that still says true.
  const { data: regRows } = await supabase
    .from("registrations")
    .select("email, phone, sms_consent, created_at")
    .order("created_at", { ascending: false });

  const phoneByEmail = new Map<string, { phone: string; consent: boolean }>();
  for (const r of regRows || []) {
    if (!r.email) continue;
    const key = r.email.toLowerCase().trim();
    if (phoneByEmail.has(key)) continue; // newest row already recorded
    phoneByEmail.set(key, { phone: r.phone || "", consent: r.sms_consent === true });
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("email, parent_name, kids");
  if (profilesError) throw new Error(profilesError.message);

  const sessionKey = (s: WeeklySession) => `${s.group}|${s.date}|${s.startTime}|${s.endTime}|${s.location}`;
  interface Internal { rawGroup: string; matched: Set<CanonicalGroupId>; timeLabel: string; location: string; athleteNames: string[] }
  const byEmail = new Map<string, { parentName: string; sessionsByKey: Map<string, Internal> }>();
  let skippedAlreadyBooked = 0;

  for (const p of profiles || []) {
    if (!p.email || !Array.isArray(p.kids)) continue;
    const emailNorm = p.email.toLowerCase().trim();
    for (const kid of p.kids as Athlete[]) {
      if (!kid.name || !kid.groups?.length) continue;
      for (const g of kid.groups) {
        const sessions = groupToSessions.get(g);
        if (!sessions) continue;
        for (const s of sessions) {
          const bookedKey = `${emailNorm}|${s.group}|${targetDate}|${s.startTime}|${s.endTime}|${s.location}`;
          if (alreadyBookedKeys.has(bookedKey)) { skippedAlreadyBooked++; continue; }

          if (!byEmail.has(p.email)) byEmail.set(p.email, { parentName: p.parent_name || "", sessionsByKey: new Map() });
          const entry = byEmail.get(p.email)!;
          const key = sessionKey(s);
          if (!entry.sessionsByKey.has(key)) {
            entry.sessionsByKey.set(key, {
              rawGroup: s.group,
              matched: new Set<CanonicalGroupId>(),
              timeLabel: s.endTime ? `${s.startTime}-${s.endTime}` : s.startTime,
              location: s.location,
              athleteNames: [],
            });
          }
          const sg = entry.sessionsByKey.get(key)!;
          sg.matched.add(g);
          if (!sg.athleteNames.includes(kid.name)) sg.athleteNames.push(kid.name);
        }
      }
    }
  }

  const recipients: BlastRecipient[] = [];
  const skippedNoConsent: BlastPreview["skippedNoConsent"] = [];

  for (const [email, { parentName, sessionsByKey }] of byEmail) {
    const contact = phoneByEmail.get(email.toLowerCase().trim());
    if (!contact || !contact.phone) {
      skippedNoConsent.push({ email, parentName, reason: "no phone on file" });
      continue;
    }
    if (!contact.consent) {
      skippedNoConsent.push({ email, parentName, reason: "not opted in to texts" });
      continue;
    }
    const sessions: BlastSession[] = Array.from(sessionsByKey.values()).map((v) => ({
      group: displayGroupLabel(v.matched, v.rawGroup),
      timeLabel: v.timeLabel,
      location: v.location,
      athleteNames: v.athleteNames,
    }));
    recipients.push({
      email,
      parentName,
      phone: contact.phone,
      sessions,
      message: buildBlastMessage(targetDate, sessions),
    });
  }

  // One number, one text, even if two of his profiles share a phone.
  const seenPhones = new Set<string>();
  const deduped = recipients.filter((r) => {
    const n = normalizePhone(r.phone);
    if (!n || seenPhones.has(n)) return false;
    seenPhones.add(n);
    return true;
  });

  return {
    ...empty,
    recipients: deduped.sort((a, b) => a.parentName.localeCompare(b.parentName)),
    skippedNoConsent,
    skippedAlreadyBooked,
  };
}

/** Prior blasts for this same date, so the confirm screen can say so out
 *  loud. The table is optional — a missing table must not break preview. */
async function readPreviousSends(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  targetDate: string
): Promise<{ sentAt: string; textsSent: number }[]> {
  try {
    const { data, error } = await supabase
      .from("group_blast_runs")
      .select("sent_at, texts_sent")
      .eq("target_date", targetDate)
      .order("sent_at", { ascending: false });
    if (error) return [];
    return (data || []).map((r) => ({ sentAt: r.sent_at, textsSent: r.texts_sent ?? 0 }));
  } catch {
    return [];
  }
}

/**
 * Actually send. Recomputes from scratch rather than trusting anything the
 * browser posted back, so what goes out is always current — if a family
 * booked in during the thirty seconds he spent reading the preview, they
 * drop out here.
 */
export async function sendGroupBlast(targetDate: string): Promise<{
  targetDate: string;
  attempted: number;
  sent: number;
  failed: { parentName: string; phone: string }[];
}> {
  const supabase = getSupabaseAdmin();
  const preview = await computeGroupBlast(targetDate);

  let sent = 0;
  const failed: { parentName: string; phone: string }[] = [];

  for (const r of preview.recipients) {
    try {
      await sendSMS(r.phone, r.message);
      sent++;
    } catch (err) {
      console.error(`Group blast SMS failed for ${r.phone}:`, err);
      failed.push({ parentName: r.parentName, phone: r.phone });
    }
  }

  try {
    await supabase.from("group_blast_runs").insert({
      target_date: targetDate,
      texts_sent: sent,
    });
  } catch (err) {
    // Logging the run is a convenience, not a precondition — never let it
    // turn a successful blast into an error.
    console.error("group_blast_runs insert failed:", err);
  }

  return { targetDate, attempted: preview.recipients.length, sent, failed };
}
