// Shared athlete/grade types and constants — safe to import from both client
// and server code (no sensitive data). This is the canonical source for
// ALL_GRADES/GRADE_ORDER, previously duplicated between schedule/page.tsx
// and settings/page.tsx.

export type CanonicalGroupId = "junior" | "ms" | "hs-girls" | "jv-boys" | "varsity-boys";

export interface Athlete {
  id: string;
  name: string;
  dob: string;
  // Sticky — see mergeAthleteAfterBooking in group-matching.ts. A submission
  // with grade "Other" never overwrites a real saved grade.
  grade: string;
  gender?: "male" | "female" | "";
  // Persisted, admin-editable group assignment set — NOT recomputed live.
  // Auto-expands (never auto-shrinks) as the athlete registers for new
  // canonical groups; the admin Groups tab can also add/remove directly.
  groups: CanonicalGroupId[];
  // Admin-only cosmetic suppression from the Groups tab list — does NOT
  // affect `groups` (still drives reminder emails) or anything the client
  // sees. For "I've already handled this one, stop cluttering my outreach
  // view" — never a data deletion.
  hidden?: boolean;
  // Past name(s) this athlete was previously saved under, recorded when an
  // admin merges a duplicate entry into this one (see the athletes/merge
  // route). Exists so a FUTURE booking that types the old (pre-merge) name
  // still resolves back onto this same entry instead of silently recreating
  // the duplicate that was just merged away — see athleteMatchesName below,
  // the one thing that actually keeps a merge permanent.
  aliases?: string[];
}

export const ALL_GRADES = [
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "1st Grade" }, { value: "2", label: "2nd Grade" },
  { value: "3", label: "3rd Grade" }, { value: "4", label: "4th Grade" },
  { value: "5", label: "5th Grade" }, { value: "6", label: "6th Grade" },
  { value: "7", label: "7th Grade" }, { value: "8", label: "8th Grade" },
  { value: "9", label: "9th Grade" }, { value: "10", label: "10th Grade" },
  { value: "11", label: "11th Grade" }, { value: "12", label: "12th Grade" },
  { value: "College +", label: "College / Pro" },
  { value: "Adult", label: "Adult" },
];

export const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "College +", "Adult"];

// The literal sentinel value the booking form offers when a kid's real
// grade doesn't fit the group being booked and the owner has approved an
// exception — see getGradesForGroup in group-matching.ts.
export const OTHER_GRADE_SENTINEL = "Other";

export function normalizedAthleteName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Does `name` refer to this saved athlete — either its current name, or one
// of its recorded aliases (a name it used to be saved under before an admin
// merged a duplicate into it)? Every place that matches an incoming booking
// against a parent's saved roster by name (not by id) should use this, not a
// bare normalizedAthleteName(...) === comparison — see the `aliases` field
// comment on Athlete for why: without it, a booking typed under the
// pre-merge name recreates the exact duplicate the merge just removed.
export function athleteMatchesName(athlete: Pick<Athlete, "name" | "aliases">, name: string): boolean {
  const target = normalizedAthleteName(name);
  if (normalizedAthleteName(athlete.name) === target) return true;
  return (athlete.aliases || []).some((a) => normalizedAthleteName(a) === target);
}

// Every gender comparison in this codebase (the schedule booking form's own
// <select value="male">, the boys/girls mismatch warning, the Coach Z NCAA
// notice check in trainers.ts, group auto-assignment) is a strict lowercase
// `=== "male"`/`=== "female"` check — signup/page.tsx used to save the
// capitalized "Male"/"Female" its own dropdown returned, straight to
// profiles.kids, with nothing normalizing it anywhere after that. A
// capitalized value silently fails every one of those checks: the booking
// form's <select> (lowercase-valued options) shows blank even though the
// saved state is non-empty, so the required-field check never catches it,
// and any place defaulting on a failed match (schedule/page.tsx's kidsStr
// builder: `gender === "male" ? "Male" : "Female"`) writes the wrong gender
// into the booking. Call this at every point gender is accepted from a
// client (signup, settings, a booking form) or read back out of the
// database, so an already-affected saved profile self-heals the moment it's
// next loaded or re-saved, without needing a data migration.
export function normalizeGender(gender: string | undefined | null): "male" | "female" | "" {
  const g = (gender || "").trim().toLowerCase();
  return g === "male" || g === "female" ? g : "";
}
