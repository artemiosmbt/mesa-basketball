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
