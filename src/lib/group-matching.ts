import { ALL_GRADES, GRADE_ORDER, OTHER_GRADE_SENTINEL, type Athlete, type CanonicalGroupId } from "@/lib/athletes";

// --- Ported verbatim from schedule/page.tsx (was module-level there) ---
// Used to parse a LIVE session/group label for gender, both for the
// existing booking-form mismatch warning and for canonicalGroupForLabel below.
export function getSessionGender(groupName: string): "boys" | "girls" | null {
  const name = groupName.toLowerCase();
  const hasBoys = name.includes("boys");
  const hasGirls = name.includes("girls");
  if (hasBoys && !hasGirls) return "boys";
  if (hasGirls && !hasBoys) return "girls";
  return null;
}

// --- Ported verbatim from schedule/page.tsx (was component-local there) ---
// Parses a live session group label's free-text grade range ("Grades 5-8",
// "Grade 5 & Below") into the selectable ALL_GRADES options, always
// appending the "Other" sentinel. Used only for the booking-form grade
// dropdown/mismatch-warning — unrelated to an athlete's persisted `groups`.
export function getGradesForGroup(groupName: string) {
  const belowMatch = groupName.match(/Grade\s+(\d+)\s*&\s*Below/i);
  if (belowMatch) {
    const ei = GRADE_ORDER.indexOf(belowMatch[1]);
    if (ei !== -1) {
      const filtered = ALL_GRADES.filter((g) => GRADE_ORDER.indexOf(g.value) <= ei);
      return [...filtered, { value: "Other", label: "Other" }];
    }
  }
  const match = groupName.match(/Grades?\s+(K|\d+)[–\-](\d+|College\s*\+?)/i);
  if (!match) return ALL_GRADES;
  const start = match[1].toUpperCase();
  const end = match[2].replace(/\s+/g, " ").trim();
  const endVal = end.toLowerCase().startsWith("college") ? "College +" : end;
  const si = GRADE_ORDER.indexOf(start);
  const ei = GRADE_ORDER.indexOf(endVal);
  if (si === -1 || ei === -1) return ALL_GRADES;
  const allowed = new Set(GRADE_ORDER.slice(si, ei + 1));
  const filtered = ALL_GRADES.filter((g) => allowed.has(g.value));
  return [...filtered, { value: "Other", label: "Other" }];
}

export interface CanonicalGroup {
  id: CanonicalGroupId;
  label: string;
  gender: "boys" | "girls" | "coed";
  minGrade: string;
  maxGrade: string;
}

// The 5 group programs the owner runs. Grade-5 boundary overlap between
// "junior" and the ms-* groups, and the top-of-bracket "play up" overlap
// between ms-* and hs-*, are both intentional — an athlete can carry more
// than one of these in their persisted `groups` at once.
export const CANONICAL_GROUPS: CanonicalGroup[] = [
  { id: "junior", label: "Junior Boys & Girls (K-5, Co-ed)", gender: "coed", minGrade: "K", maxGrade: "5" },
  { id: "ms-boys", label: "Middle School Boys (5-8)", gender: "boys", minGrade: "5", maxGrade: "8" },
  { id: "ms-girls", label: "Middle School Girls (5-8)", gender: "girls", minGrade: "5", maxGrade: "8" },
  { id: "hs-girls", label: "High School Girls (9-12)", gender: "girls", minGrade: "9", maxGrade: "12" },
  { id: "hs-boys", label: "High School Boys (9-12)", gender: "boys", minGrade: "9", maxGrade: "12" },
];

// Maps a LIVE session label (WeeklySession.group / registrations.booked_group)
// to one of the 5 canonical groups via keywords, not exact string match — so
// wording variants like "Middle School Boys 5-8" and "Middle School Boys -
// Grades 5-8" both resolve to "ms-boys" with no special-casing needed. If
// the live schedule is ever reworded to drop these keywords, matching for
// that group silently stops working everywhere (reminder emails, Groups
// tab, auto-assign-on-booking) — worth a quick sanity check whenever a
// schedule label changes.
export function canonicalGroupForLabel(liveLabel: string): CanonicalGroupId | null {
  const name = liveLabel.toLowerCase();
  const gender = getSessionGender(liveLabel);
  if (name.includes("junior")) return "junior";
  if (name.includes("middle school") && gender === "boys") return "ms-boys";
  if (name.includes("middle school") && gender === "girls") return "ms-girls";
  if (name.includes("high school") && gender === "girls") return "hs-girls";
  if (name.includes("high school") && gender === "boys") return "hs-boys";
  return null;
}

function gradeInRange(grade: string, min: string, max: string): boolean {
  const gi = GRADE_ORDER.indexOf(grade);
  const lo = GRADE_ORDER.indexOf(min);
  const hi = GRADE_ORDER.indexOf(max);
  return gi !== -1 && gi >= lo && gi <= hi;
}

// Seeds a brand-new athlete's initial `groups` from grade+gender alone, for
// the case where they have no registration history yet to seed from
// instead (see mergeAthleteAfterBooking below, and the backfill route,
// which prefers real history when it exists).
export function defaultGroupsForGradeGender(grade: string, gender: string | undefined): CanonicalGroupId[] {
  return CANONICAL_GROUPS.filter((g) => {
    if (!gradeInRange(grade, g.minGrade, g.maxGrade)) return false;
    return g.gender === "coed" || g.gender === gender;
  }).map((g) => g.id);
}

// Merges a booking-form submission into an athlete's saved record.
// - Grade "sticks" to the last real value entered: a submission of the
//   literal "Other" sentinel (used when a kid's real grade doesn't fit the
//   group they're signing up for and the owner is letting them join anyway)
//   never overwrites the saved grade; any other non-empty grade does.
// - Every label in bookedGroupLabels that resolves to a canonical group is
//   ADDED to the athlete's persisted `groups` if not already present — never
//   removed automatically. This is how kids "age up" over time without the
//   owner manually updating everyone every year. Takes an array (not a
//   single label) because one weekly booking can span multiple distinct
//   groups at once (e.g. a combined "Group Sessions" booking mixing a
//   Junior slot with a Middle School slot).
export function mergeAthleteAfterBooking(existing: Athlete, incoming: Partial<Athlete>, bookedGroupLabels?: string[]): Athlete {
  const merged: Athlete = {
    ...existing,
    name: incoming.name?.trim() || existing.name,
    dob: incoming.dob || existing.dob,
    grade: incoming.grade && incoming.grade !== OTHER_GRADE_SENTINEL ? incoming.grade : existing.grade,
    gender: incoming.gender || existing.gender,
    groups: [...existing.groups],
  };
  for (const label of bookedGroupLabels || []) {
    const cg = canonicalGroupForLabel(label);
    if (cg && !merged.groups.includes(cg)) merged.groups.push(cg);
  }
  return merged;
}
