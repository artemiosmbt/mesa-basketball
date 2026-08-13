/**
 * Maps a trainer's display name (as it appears in schedule data) to the
 * anchor slug of their bio section on /about. Only trainers listed here get
 * a "Show Bio" link on the schedule page — add an entry once that trainer
 * has a bio section written on the About page.
 */
export const TRAINER_BIO_SLUGS: Record<string, string> = {
  "Artemios Gavalas": "artemios-gavalas",
  // Keyed on "Joseph Owens" (the exact name configured in TRAINER_ACCOUNTS/
  // payroll-sync.ts's TRAINERS, and what actually appears as booked_trainer
  // on the schedule sheet) even though his About page bio displays as
  // "Joe Owens" — this key must match the schedule-data string for the
  // "Show Bio" link to actually appear next to his sessions.
  "Joseph Owens": "joe-owens",
  "Steven Papadimitropoulos": "steven-papadimitropoulos",
  "Zain Amjad": "zain-amjad",
  "Zhaneia Thybulle": "zhaneia-thybulle",
};

export function getTrainerBioSlug(name: string): string | null {
  return TRAINER_BIO_SLUGS[name.trim()] ?? null;
}

// Normalizes a hand-typed trainer name for EQUALITY COMPARISONS only (never
// for storage/display — always keep/write whatever the sheet's real casing
// is). Every site that compares two trainer-name strings for equality
// (group-capacity pooling, private-slot conflict detection, trainer
// dashboard scoping, trainer contact/notification lookup) must run both
// sides through this first. Without it, a stray capitalization or extra
// space typed into the schedule sheet on one edit vs. another silently
// splits what should be one trainer's data in two — e.g. a group's
// capacity pool fragmenting into "Zain Amjad" and "zain amjad" halves (each
// under-counting, allowing an accidental overbook), or the same trainer
// getting double-booked across two private slots because the conflict
// check never sees them as the same person. payroll-sync.ts already
// learned this the hard way (see its own normalizeTrainerName) — this is
// the same fix applied everywhere else trainer names get compared.
export function normalizeTrainerNameForComparison(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function trainerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeTrainerNameForComparison(a) === normalizeTrainerNameForComparison(b);
}

// Client-facing display only — never use this for storage, comparison, or
// tier/price lookups (those must keep reading the raw "TBD" value; getTrainerTier
// still needs to see the literal string). "TBD" on the schedule sheet is a
// real, bookable option meaning "any trainer covering this session works for
// me" (client-facing, opt-in flexibility) — NOT "unconfirmed"/"not decided
// yet." Shown as "Any Available Trainer" so that meaning is explicit rather
// than the bare, ambiguous letters "TBD".
export function formatTrainerForDisplay(name: string | null | undefined): string {
  const n = (name || "").trim();
  return n === "TBD" ? "Any Available Trainer" : (n || "Artemios Gavalas");
}

export type TrainerTier = "artemios" | "other";

// The one name that prices/redeems at the "owner" tier. Every other trainer
// name — including sheet typos or names not yet added anywhere else — falls
// back to "other" rather than erroring, since treating an unrecognized name
// as a (cheaper) substitute is the safe direction: it can never overcharge a
// client or let a package under-cover a session.
const OWNER_TRAINER_NAME = "Artemios Gavalas";

export function getTrainerTier(name: string | undefined | null): TrainerTier {
  // Case/whitespace-insensitive, same as every other trainer-name comparison
  // in this file (trainerNamesMatch) — a hand-typed schedule-sheet casing
  // drift (e.g. "artemios gavalas") would otherwise silently fall through
  // to the cheaper "other" tier instead of matching the owner.
  return trainerNamesMatch(name, OWNER_TRAINER_NAME) ? "artemios" : "other";
}

// Validates a value read back from the database (monthly_packages.trainer_tier)
// against the two real tiers, rather than trusting a bare `as TrainerTier`
// cast — the app only ever writes "artemios"/"other" itself, but this is the
// boundary where a stray manual DB edit or future bug could otherwise slip
// an unrecognized string straight into a price-table lookup and silently
// return undefined/NaN. Defaults to "artemios" (not "other") to match the
// pre-trainer_tier backfill, which was always Artemios-tier.
//
// This defaults the OPPOSITE direction from getTrainerTier above, and
// deliberately so — the two answer different questions. getTrainerTier maps
// a trainer NAME to a tier, where an unrecognized name is presumably a new/
// unlisted substitute, so "other" (the cheaper tier) is the safe guess.
// normalizeTrainerTier maps an already-stored TIER VALUE back to a real
// tier, where a missing/legacy value always meant Artemios historically —
// "artemios" is the correct guess there, not merely the safe one.
export function normalizeTrainerTier(value: string | undefined | null): TrainerTier {
  return value === "other" ? "other" : "artemios";
}

// Whether a package purchased at `packageTier` can cover a session run at
// `sessionTier`. Deliberately asymmetric, not a simple equality check: a
// package bought at the "artemios" (premium) tier already paid his higher
// rate, so it can cover a session with him OR with a substitute covering for
// him. A package bought at the "other" (cheaper substitute) tier stays
// restricted to substitute trainers only — it must never let someone who
// paid the cheaper rate book Artemios's own premium sessions for free.
export function packageCoversTrainerTier(packageTier: TrainerTier, sessionTier: TrainerTier): boolean {
  return packageTier === "artemios" || packageTier === sessionTier;
}
