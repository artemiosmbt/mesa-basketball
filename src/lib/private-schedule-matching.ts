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
    const trainerCovers = (t: string) => {
      const trainerIntervals = sameDayLocation
        .filter((s) => s.trainer === t)
        .map((s) => ({ start: parseTimeMins(s.startTime), end: parseTimeMins(s.endTime) }))
        .filter((s): s is { start: number; end: number } => s.start !== null && s.end !== null);
      return intervalsCoverRange(trainerIntervals, regStart, regEnd);
    };
    // If the trainer already on the booking still has a slot covering this
    // exact window, nothing changed for them — leave it alone. Without this
    // check, two trainers each legitimately booked at the same date/
    // location/time (e.g. two different clients' private sessions running
    // side by side) would race on `.find()`'s sheet-row order below, and
    // whichever trainer's row happened to come first would silently steal
    // the OTHER trainer's already-correct booking, double-booking that
    // trainer at the same time slot.
    if (trainerCovers(currentTrainer)) continue;
    const coveringTrainer = trainersHere.find(trainerCovers);
    if (coveringTrainer && coveringTrainer !== currentTrainer) {
      result.push({ reg: r, newTrainer: coveringTrainer });
    }
  }
  return result;
}

// Private-session counterpart to the weekly LOCATION-only branch of
// buildWeeklyPlan — detects a confirmed private/group-private registration
// whose exact booked date/start/end interval is no longer covered at its
// OWN stored booked_location, but is still covered (as the exact same
// interval) at exactly one OTHER location on the sheet. That's what it looks
// like when a trainer's availability window itself moves location (e.g. "I'm
// actually at Cherry Valley instead of St. Paul's that day") — the client's
// booking should follow the window, not be silently orphaned or treated as
// cancelled (privateBookingStillOnSheet already avoids the latter, but until
// this ran, nothing ever picked up on the former: booked_location stayed
// stale and the client was never told).
//
// Only acts when EXACTLY one other location covers the interval — if none
// do, it's a genuine deletion (handled separately); if more than one do,
// guessing which location the client's session actually followed to would
// risk sending a wrong-location text, so those come back in `ambiguous`
// instead — same "flag for manual review rather than guess" reasoning as
// buildWeeklyPlan's own ambiguous bucket, which the caller alerts the admin
// about the same way.
export function findPrivateLocationChanges<
  T extends { id: string; booked_date: string | null; booked_start_time: string | null; booked_end_time: string | null; booked_location: string | null }
>(
  regs: T[],
  slots: { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
): { changes: { reg: T; newLocation: string }[]; ambiguous: T[] } {
  const changes: { reg: T; newLocation: string }[] = [];
  const ambiguous: T[] = [];
  for (const r of regs) {
    const regStart = parseTimeMins(r.booked_start_time || "");
    const regEnd = parseTimeMins(r.booked_end_time || "");
    if (regStart === null || regEnd === null) continue;
    const oldLocation = r.booked_location || "";

    const byLocation: Record<string, { start: number; end: number }[]> = {};
    slots
      .filter((s) => s.date === r.booked_date)
      .forEach((s) => {
        const start = parseTimeMins(s.startTime);
        const end = parseTimeMins(s.endTime);
        if (start === null || end === null) return;
        if (!byLocation[s.location]) byLocation[s.location] = [];
        byLocation[s.location].push({ start, end });
      });

    if (byLocation[oldLocation] && intervalsCoverRange(byLocation[oldLocation], regStart, regEnd)) continue;

    const coveringLocations = Object.keys(byLocation).filter((loc) => intervalsCoverRange(byLocation[loc], regStart, regEnd));
    if (coveringLocations.length === 1 && coveringLocations[0] !== oldLocation) {
      changes.push({ reg: r, newLocation: coveringLocations[0] });
    } else if (coveringLocations.length > 1) {
      ambiguous.push(r);
    }
  }
  return { changes, ambiguous };
}

// Same optimistic-concurrency pattern as claimWeeklyTimeChange, scoped to
// booked_location (date/time are unchanged in this scenario — only the
// window's location moved) — whichever of the cron/admin-sync routes' UPDATE
// actually lands first "wins"; the loser's WHERE clause matches zero rows
// and it's a silent no-op, not a duplicate write/notification. Also guarded
// on status still being "confirmed" — same reasoning as every deletion/
// cancellation claim elsewhere in this codebase: a client cancelling this
// exact booking at the same moment this runs must not have it silently
// rewritten (and a "LOCATION CHANGE" text sent) after it's already cancelled.
export async function claimPrivateLocationChange(
  supabase: SupabaseClient,
  reg: { id: string; booked_location: string | null },
  updates: { booked_location: string; session_details: string }
): Promise<boolean> {
  let query = supabase
    .from("registrations")
    .update({ ...updates, admin_change_at: new Date().toISOString() })
    .eq("id", reg.id)
    .eq("status", "confirmed");
  query = reg.booked_location === null ? query.is("booked_location", null) : query.eq("booked_location", reg.booked_location);
  const { data } = await query.select("id");
  return !!data && data.length > 0;
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
