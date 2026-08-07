// Shared athlete/grade types and constants — safe to import from both client
// and server code (no sensitive data). This is the canonical source for
// ALL_GRADES/GRADE_ORDER, previously duplicated between schedule/page.tsx
// and settings/page.tsx.

export type CanonicalGroupId = "junior" | "ms-boys" | "ms-girls" | "hs-girls" | "hs-boys";

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
