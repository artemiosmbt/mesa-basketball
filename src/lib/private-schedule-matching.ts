import type { SupabaseClient } from "@supabase/supabase-js";

// Shared by src/app/api/cron/detect-time-changes/route.ts (fires on every
// sheet edit) and src/app/api/admin/sync-time-changes/route.ts (fires on
// every admin dashboard load) — same reason buildWeeklyPlan/
// findWeeklyTrainerReassignments live in weekly-schedule-matching.ts instead
// of either route: keeping this in one place is what stops the two routes
// drifting out of sync with each other (the weekly side already drifted
// once before that fix).

export function parseTimeMins(t: string): number | null {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

// Merges consecutive (touching) intervals and reports whether the resulting
// union fully covers [rangeStart, rangeEnd).
export function intervalsCoverRange(intervals: { start: number; end: number }[], rangeStart: number, rangeEnd: number): boolean {
  if (intervals.length === 0) return false;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let windowStart = sorted[0].start;
  let windowEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start === windowEnd) {
      windowEnd = sorted[i].end;
    } else {
      if (rangeStart >= windowStart && rangeEnd <= windowEnd) return true;
      windowStart = sorted[i].start;
      windowEnd = sorted[i].end;
    }
  }
  return rangeStart >= windowStart && rangeEnd <= windowEnd;
}

// Private-session counterpart to findWeeklyTrainerReassignments — detects
// confirmed private/group-private registrations whose stored booked_trainer
// no longer matches whichever trainer's sheet slots actually cover that
// EXACT date/time/location. Quiet, internal-only reconciliation (like the
// weekly version): no client notification, but the assigned trainer(s) do
// still get notified — see each call site.
export function findPrivateTrainerReassignments<
  T extends { id: string; booked_date: string | null; booked_start_time: string | null; booked_end_time: string | null; booked_location: string | null; booked_trainer: string | null }
>(
  regs: T[],
  slots: { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
): { reg: T; newTrainer: string }[] {
  const result: { reg: T; newTrainer: string }[] = [];
  for (const r of regs) {
    const regStart = parseTimeMins(r.booked_start_time || "");
    const regEnd = parseTimeMins(r.booked_end_time || "");
    if (regStart === null || regEnd === null) continue;

    const sameDayLocation = slots.filter((s) => s.date === r.booked_date && s.location === (r.booked_location || ""));
    const trainersHere = [...new Set(sameDayLocation.map((s) => s.trainer))];
    const covered: { start: number; end: number }[] = sameDayLocation
      .map((s) => ({ start: parseTimeMins(s.startTime), end: parseTimeMins(s.endTime) }))
      .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null);
    // Only act when the registration's exact range still genuinely exists
    // somewhere on the sheet — if it doesn't, that's a real deletion,
    // handled entirely separately, not a trainer swap.
    if (!intervalsCoverRange(covered, regStart, regEnd)) continue;

    const currentTrainer = r.booked_trainer || "Artemios Gavalas";
    const coveringTrainer = trainersHere.find((t) => {
      const trainerIntervals = sameDayLocation
        .filter((s) => s.trainer === t)
        .map((s) => ({ start: parseTimeMins(s.startTime), end: parseTimeMins(s.endTime) }))
        .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null);
      return intervalsCoverRange(trainerIntervals, regStart, regEnd);
    });
    if (coveringTrainer && coveringTrainer !== currentTrainer) {
      result.push({ reg: r, newTrainer: coveringTrainer });
    }
  }
  return result;
}

// Same optimistic-concurrency pattern as claimWeeklyTrainerReassignment —
// whichever of the cron/admin-sync routes' UPDATE actually lands first
// "wins"; the loser's WHERE clause matches zero rows and it's a silent
// no-op, not a duplicate write/notification.
export async function claimPrivateTrainerReassignment(
  supabase: SupabaseClient,
  reg: { id: string; booked_trainer: string | null },
  newTrainer: string
): Promise<boolean> {
  let query = supabase
    .from("registrations")
    .update({ booked_trainer: newTrainer })
    .eq("id", reg.id);
  query = reg.booked_trainer === null ? query.is("booked_trainer", null) : query.eq("booked_trainer", reg.booked_trainer);
  const { data } = await query.select("id");
  return !!data && data.length > 0;
}
