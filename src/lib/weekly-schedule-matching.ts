import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklySession } from "@/lib/sheets";

export interface WeeklyRegKeyFields {
  id: string;
  booked_date: string | null;
  booked_start_time: string;
  booked_end_time: string | null;
  booked_location: string | null;
  booked_group: string | null;
  session_details: string | null;
}

// Every weekly registration stores its own exact group name in booked_group
// (added specifically to disambiguate — see the same pattern in
// src/lib/supabase.ts's getCampGroupByReferralCode). Prefer that exact
// value; only fall back to parsing session_details for legacy rows booked
// before that column existed. Returns the actual group name string (needed
// to bucket registrations by date+group), not just a yes/no match — without
// this, a group name that happens to be a substring of another (e.g.
// "Elite" inside "Elite Advanced") could misattribute or "lose"
// registrations under a plain substring check.
export function regGroupKey(r: Pick<WeeklyRegKeyFields, "booked_group" | "session_details">): string {
  return r.booked_group || (r.session_details || "").split(" — ")[0].trim() || "";
}

// A group name can legitimately run more than once on the same calendar day
// at different times (e.g. an AM and PM session sharing the exact same
// name) — matching purely on date+group would then let one slot's deletion
// or time-change be masked by the other slot still existing. This buckets
// registrations by date+group, then by each registration's own currently-
// stored start time (each distinct time = one session instance as last
// synced), and matches every bucket against the live sheet rows for that
// date+group:
//   - a bucket whose stored start/end/location exactly matches a sheet row
//     is unchanged — no action needed.
//   - if exactly one bucket is left unmatched and exactly one sheet row is
//     unclaimed, that's an unambiguous time/location change.
//   - if every sheet row for that date+group ends up claimed by some other
//     bucket (zero unclaimed rows left), the remaining unmatched bucket(s)
//     were genuinely deleted.
//   - anything else (multiple unmatched buckets and/or multiple unclaimed
//     rows at once) can't be resolved without guessing which bucket maps to
//     which row — flagged as ambiguous instead of risking a wrong
//     auto-cancel/refund or auto-reschedule of a real booking.
//
// Shared between src/app/api/cron/detect-time-changes/route.ts (the
// automatic sheet-edit-triggered sync) and
// src/app/api/admin/sync-time-changes/route.ts (the admin-dashboard-load-
// triggered sync) — these two run independently with no coordination
// between them, so keeping the matching logic in one place is what stops
// them drifting out of sync with each other again (they already did once:
// only the cron got the exact-booked_group fix until this refactor).
export function buildWeeklyPlan<T extends WeeklyRegKeyFields>(sheetRows: WeeklySession[], regs: T[]) {
  const changes: { reg: T; newSession: WeeklySession }[] = [];
  const deletions: T[] = [];
  const ambiguous: { date: string; group: string; regCount: number }[] = [];

  const sheetByKey = new Map<string, WeeklySession[]>();
  for (const s of sheetRows) {
    const key = `${s.date}|${s.group}`;
    if (!sheetByKey.has(key)) sheetByKey.set(key, []);
    sheetByKey.get(key)!.push(s);
  }

  const regsByKey = new Map<string, T[]>();
  for (const r of regs) {
    if (!r.booked_date) continue;
    const g = regGroupKey(r);
    if (!g) continue;
    const key = `${r.booked_date}|${g}`;
    if (!regsByKey.has(key)) regsByKey.set(key, []);
    regsByKey.get(key)!.push(r);
  }

  for (const [key, keyRegs] of regsByKey) {
    const sheetRowsForKey = sheetByKey.get(key) || [];

    const bucketsByTime = new Map<string, T[]>();
    for (const r of keyRegs) {
      const t = r.booked_start_time || "";
      if (!bucketsByTime.has(t)) bucketsByTime.set(t, []);
      bucketsByTime.get(t)!.push(r);
    }

    const claimedRowIdx = new Set<number>();
    const unresolvedBuckets: { regs: T[] }[] = [];

    for (const bucketRegs of bucketsByTime.values()) {
      const sample = bucketRegs[0];
      const matchIdx = sheetRowsForKey.findIndex(
        (s, i) =>
          !claimedRowIdx.has(i) &&
          s.startTime === sample.booked_start_time &&
          s.endTime === (sample.booked_end_time || "") &&
          s.location === (sample.booked_location || "")
      );
      if (matchIdx !== -1) {
        claimedRowIdx.add(matchIdx);
        continue;
      }
      unresolvedBuckets.push({ regs: bucketRegs });
    }

    if (unresolvedBuckets.length === 0) continue;

    const unclaimedRows = sheetRowsForKey.filter((_, i) => !claimedRowIdx.has(i));

    if (unresolvedBuckets.length === 1 && unclaimedRows.length === 1) {
      for (const r of unresolvedBuckets[0].regs) changes.push({ reg: r, newSession: unclaimedRows[0] });
      continue;
    }

    if (unclaimedRows.length === 0) {
      for (const bucket of unresolvedBuckets) for (const r of bucket.regs) deletions.push(r);
      continue;
    }

    const [date, group] = key.split("|");
    ambiguous.push({ date, group, regCount: unresolvedBuckets.reduce((n, b) => n + b.regs.length, 0) });
  }

  return { changes, deletions, ambiguous };
}

// The automatic cron (fires on every sheet edit, via Apps Script) and the
// admin-dashboard-triggered sync (fires on every dashboard load) both watch
// for the exact same weekly time/location changes with no coordination
// between them — if an admin edits the sheet and then happens to reload the
// dashboard shortly after, both can independently see the same registration
// as "stale" before either one's write has landed, and both would notify
// the client. This makes the update conditional on the OLD start/end/
// location still matching what was actually read (optimistic concurrency,
// no new schema needed) — whichever request's UPDATE actually lands first
// "wins" and is the only one that proceeds to send the notification; the
// loser's WHERE clause matches zero rows and it skips sending anything.
// Detects registrations whose stored booked_trainer no longer matches the
// sheet's current trainer for that EXACT date+group+time+location — e.g.
// staff swapped in a substitute coach for an already-booked session
// ("something came up, need someone to cover"). Deliberately separate from
// buildWeeklyPlan's time/location matching above: a pure trainer swap needs
// no client notification and no optimistic-concurrency race handling like a
// real time/location change does (worst case of acting on a stale read here
// is just correcting itself on the next sync pass, never an erroneous
// refund or cancellation) — and group capacity is now pooled per trainer
// (see checkGroupSessionCapacity), so leaving a stale booked_trainer here
// would silently let a new booking under the sheet's current trainer check
// a different, emptier capacity pool than the one these existing
// registrants are actually counted in.
export function findWeeklyTrainerReassignments<T extends WeeklyRegKeyFields & { booked_trainer: string | null }>(
  sheetRows: WeeklySession[],
  regs: T[]
): { reg: T; newTrainer: string }[] {
  const result: { reg: T; newTrainer: string }[] = [];
  for (const r of regs) {
    if (!r.booked_date) continue;
    const g = regGroupKey(r);
    if (!g) continue;
    const match = sheetRows.find(
      (s) =>
        s.date === r.booked_date &&
        s.group === g &&
        s.startTime === r.booked_start_time &&
        s.endTime === (r.booked_end_time || "") &&
        s.location === (r.booked_location || "")
    );
    if (!match) continue; // no exact slot match — a real time/location change, handled by buildWeeklyPlan instead
    const sheetTrainer = match.trainer || "Artemios Gavalas";
    const currentTrainer = r.booked_trainer || "Artemios Gavalas";
    if (sheetTrainer !== currentTrainer) {
      result.push({ reg: r, newTrainer: sheetTrainer });
    }
  }
  return result;
}

// Same optimistic-concurrency pattern as claimWeeklyTimeChange, scoped to
// just booked_trainer — whichever of the two sync routes' UPDATE actually
// lands first "wins"; the loser's WHERE clause matches zero rows and it's a
// silent no-op, not a duplicate write.
export async function claimWeeklyTrainerReassignment(
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

export async function claimWeeklyTimeChange(
  supabase: SupabaseClient,
  reg: WeeklyRegKeyFields,
  updates: { booked_start_time: string; booked_end_time: string; booked_location?: string; session_details: string }
): Promise<boolean> {
  let query = supabase
    .from("registrations")
    .update({ ...updates, admin_change_at: new Date().toISOString() })
    .eq("id", reg.id)
    .eq("booked_start_time", reg.booked_start_time);
  query = reg.booked_end_time === null ? query.is("booked_end_time", null) : query.eq("booked_end_time", reg.booked_end_time);
  query = reg.booked_location === null ? query.is("booked_location", null) : query.eq("booked_location", reg.booked_location);
  const { data } = await query.select("id");
  return !!data && data.length > 0;
}
