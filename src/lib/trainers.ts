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
