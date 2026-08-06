/**
 * Maps a trainer's display name (as it appears in schedule data) to the
 * anchor slug of their bio section on /about. Only trainers listed here get
 * a "Show Bio" link on the schedule page — add an entry once that trainer
 * has a bio section written on the About page.
 */
export const TRAINER_BIO_SLUGS: Record<string, string> = {
  "Artemios Gavalas": "artemios-gavalas",
};

export function getTrainerBioSlug(name: string): string | null {
  return TRAINER_BIO_SLUGS[name.trim()] ?? null;
}

export type TrainerTier = "artemios" | "other";

// The one name that prices/redeems at the "owner" tier. Every other trainer
// name — including sheet typos or names not yet added anywhere else — falls
// back to "other" rather than erroring, since treating an unrecognized name
// as a (cheaper) substitute is the safe direction: it can never overcharge a
// client or let a package under-cover a session.
const OWNER_TRAINER_NAME = "Artemios Gavalas";

export function getTrainerTier(name: string | undefined | null): TrainerTier {
  return (name || "").trim() === OWNER_TRAINER_NAME ? "artemios" : "other";
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
