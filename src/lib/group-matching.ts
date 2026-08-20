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

// Normalizes a hand-typed group/location label for EQUALITY COMPARISONS only
// (never for storage/display — always keep/write whatever the sheet's real
// text is). Same fix as trainers.ts's normalizeTrainerNameForComparison,
// applied to group/location strings: a stray capitalization or extra space
// typed into the schedule sheet must not make a session look "deleted" to
// code that matches registrations against live sheet rows by exact string
// (weekly-schedule-matching.ts, booking-finalize.ts's live repricing) — that
// class of bug previously auto-cancelled real, still-happening sessions and
// issued real refunds for them.
export function normalizeSessionLabelForComparison(label: string | null | undefined): string {
  return (label || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CanonicalGroup {
  id: CanonicalGroupId;
  label: string;
  // Admin Groups-tab section-header text only — verbatim copy of the live
  // schedule card's own group name, whatever it actually says (most cards
  // carry no grade info; Junior's happens to bake "— Grade 5 & Below" into
  // its own live name, so that stays). Never hand-write extra grade/coed
  // detail here that isn't literally on the card. Kept separate from
  // `label` (the fuller hand-written text stays useful on the per-athlete
  // badges and toggle buttons elsewhere in the Groups tab) so this doesn't
  // ripple into those.
  shortLabel: string;
  gender: "boys" | "girls" | "coed";
  minGrade: string;
  maxGrade: string;
  // Whether a brand-new athlete with no booking history yet should be
  // seeded into this group from grade+gender alone (see
  // defaultGroupsForGradeGender). JV vs Varsity is a skill-tier split, not
  // an age/gender one — grade+gender can't tell them apart, so guessing
  // both would wrongly put every new 9-12 boy on both rosters (and both
  // groups' reminder emails) until a real booking narrows it down. Left
  // unset (true) for every other group, where grade+gender IS enough.
  autoSeed?: boolean;
}

// The 5 group programs the owner runs. Grade ranges deliberately overlap
// between groups (junior/ms at grade 5, ms/hs-girls at 7-8, jv-boys/
// varsity-boys at 8-10) — these are skill-tier splits as much as age ones,
// so an athlete can legitimately belong to more than one at once (e.g.
// "playing up"), and can carry more than one in their persisted `groups`.
export const CANONICAL_GROUPS: CanonicalGroup[] = [
  { id: "junior", label: "Junior Boys & Girls (K-5th, Co-ed)", shortLabel: "Junior Boys & Girls — Grade 5 & Below", gender: "coed", minGrade: "K", maxGrade: "5" },
  { id: "ms", label: "Middle School Boys & Girls (5th-8th, Co-ed)", shortLabel: "Middle School Boys & Girls", gender: "coed", minGrade: "5", maxGrade: "8" },
  { id: "hs-girls", label: "High School Girls (7th-12th)", shortLabel: "High School Girls", gender: "girls", minGrade: "7", maxGrade: "12" },
  { id: "jv-boys", label: "JV Boys (7th-10th)", shortLabel: "JV Boys", gender: "boys", minGrade: "7", maxGrade: "10", autoSeed: false },
  { id: "varsity-boys", label: "Varsity Boys (8th-12th)", shortLabel: "Varsity Boys", gender: "boys", minGrade: "8", maxGrade: "12", autoSeed: false },
];

// Maps a LIVE session label (WeeklySession.group / registrations.booked_group)
// to the canonical group(s) it belongs to, via keywords rather than exact
// string match — so wording variants still resolve without special-casing.
// Returns an array (rather than a single id) because the combo "JV &
// Varsity Boys" session (see COMBO_GROUPS in schedule/page.tsx) genuinely
// belongs to BOTH jv-boys and varsity-boys at once — kids in either group
// should get reminded about it, and a kid who books it should pick up both.
// If the live schedule is ever reworded to drop these keywords, matching
// for that group silently stops working everywhere (reminder emails,
// Groups tab, auto-assign-on-booking) — worth a quick sanity check whenever
// a schedule label changes.
export function canonicalGroupForLabel(liveLabel: string): CanonicalGroupId[] {
  const name = liveLabel.toLowerCase();
  const hasJV = /\bjv\b/.test(name);
  const hasVarsity = name.includes("varsity");
  if (hasJV && hasVarsity) return ["jv-boys", "varsity-boys"];
  if (hasJV) return ["jv-boys"];
  if (hasVarsity) return ["varsity-boys"];
  if (name.includes("junior") || /\bjr\b/.test(name)) return ["junior"];
  if (name.includes("middle school")) return ["ms"];
  if (name.includes("high school") && name.includes("girls")) return ["hs-girls"];
  return [];
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
    if (g.autoSeed === false) return false;
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
    for (const cg of canonicalGroupForLabel(label)) {
      if (!merged.groups.includes(cg)) merged.groups.push(cg);
    }
  }
  return merged;
}
