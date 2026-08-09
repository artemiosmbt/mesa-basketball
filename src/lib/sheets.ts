import { trainerNamesMatch } from "@/lib/trainers";

export interface WeeklySession {
  group: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  maxSpots: number;
  price: number;
  trainer?: string;
}

export interface Camp {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  time: string;
  location: string;
  maxSpots: number;
  currentEnrolled: number;
  price: string;
  description: string;
  notify: boolean;
  // multi-group camp fields (optional — col K-N)
  gradeGroup: string;
  earlyBirdPrice: string;
  dropInPrice: string;
  campDays: string[];
}

export interface PrivateSlot {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  available: boolean;
  trainer: string;
}

function parseCSV(text: string): string[][] {
  const lines = text.trim().split("\n");
  return lines.map((line) => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

export async function getWeeklySchedule(options?: { noCache?: boolean }): Promise<WeeklySession[]> {
  const url = process.env.SHEET_CSV_WEEKLY_SCHEDULE;
  if (!url) {
    console.error("SHEET_CSV_WEEKLY_SCHEDULE is not set — returning an empty schedule instead of the real one.");
    return [];
  }
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  // Skip header row
  return rows.slice(1).map((row) => ({
    group: row[0] || "",
    date: row[1] || "",
    startTime: row[2] || "",
    endTime: row[3] || "",
    location: row[4] || "",
    maxSpots: parseInt(row[5]) || 8,
    price: parseInt(row[6]) || 50,
    // Column H (index 7) is "Day of Week"; column I (index 8) is the optional
    // Trainer column — defaults to Artemios when not filled in.
    trainer: (row[8] || "").trim() || "Artemios Gavalas",
  }));
}

export async function getCamps(options?: { noCache?: boolean }): Promise<Camp[]> {
  const url = process.env.SHEET_CSV_CAMPS;
  if (!url) {
    console.error("SHEET_CSV_CAMPS is not set — returning an empty camp list instead of the real one.");
    return [];
  }
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  return rows.slice(1).map((row, i) => ({
    id: `camp-${i}`,
    name: row[0] || "",
    startDate: row[1] || "",
    endDate: row[2] || "",
    time: row[3] || "",
    location: row[4] || "",
    maxSpots: parseInt(row[5]) || 20,
    currentEnrolled: parseInt(row[6]) || 0,
    price: row[7] || "",
    description: row[8] || "",
    notify: (row[9] || "").toUpperCase() === "TRUE",
    gradeGroup: row[10] || "",
    earlyBirdPrice: row[11] || "",
    dropInPrice: row[12] || "",
    campDays: row[13] ? row[13].split("|").map((d) => d.trim()).filter(Boolean) : [],
  })).filter((camp) => camp.name);
}

export async function getPrivateSlots(options?: { noCache?: boolean }): Promise<PrivateSlot[]> {
  const url = process.env.SHEET_CSV_PRIVATE_SLOTS;
  if (!url) {
    console.error("SHEET_CSV_PRIVATE_SLOTS is not set — returning an empty slot list instead of the real one.");
    return [];
  }
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  return rows.slice(1).map((row, i) => ({
    id: `slot-${i}`,
    date: row[0] || "",
    startTime: row[1] || "",
    endTime: row[2] || "",
    location: row[3] || "",
    available: (row[4] || "").toUpperCase() === "TRUE",
    // Column F (index 5) is "Day of Week"; column G (index 6) is the optional
    // Trainer column — defaults to Artemios when not filled in.
    trainer: (row[6] || "").trim() || "Artemios Gavalas",
  }));
}

export function parseTimeToMins(t: string): number {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

// Verifies that [startTime, endTime) on `date` at `location` is actually
// covered by consecutive, available Sheet rows for `trainer` — the same
// "merge consecutive slots into a window" rule the schedule page uses for
// display, applied server-side as a real gate instead of just a UI hint.
// Without this, nothing stopped a request from claiming a trainer/price/slot
// combination that was never actually offered (a stale tab, a slot the
// business pulled while the form was open, or a request built by hand) —
// which, once price depends on which trainer is picked, is a pricing
// integrity gap, not just a display one.
export async function isPrivateWindowOfferedByTrainer(
  date: string,
  startTime: string,
  endTime: string,
  location: string,
  trainer: string
): Promise<boolean> {
  // noCache: true — this is a real pricing/availability gate (trainer
  // determines price), not a display read, so it must never validate
  // against a stale up-to-60-second-old cached schedule. Mirrors the same
  // noCache choice register/route.ts makes for the weekly live-schedule
  // re-verification, for the same reason.
  const slots = await getPrivateSlots({ noCache: true });
  const wantStart = parseTimeToMins(startTime);
  const wantEnd = parseTimeToMins(endTime);
  if (wantEnd <= wantStart) return false;
  // Trainer compared via normalizeTrainerNameForComparison, not exact `===`
  // — see trainers.ts for why (hand-typed sheet cell casing/whitespace
  // drift must never make this reject a real, currently-offered window).
  const relevant = slots
    .filter((s) => s.date === date && s.location === location && trainerNamesMatch(s.trainer, trainer) && s.available)
    .map((s) => ({ start: parseTimeToMins(s.startTime), end: parseTimeToMins(s.endTime) }))
    .sort((a, b) => a.start - b.start);

  let cursor = wantStart;
  for (const s of relevant) {
    if (s.start > cursor) break; // gap before this block — coverage broken
    if (s.end > cursor) cursor = s.end;
    if (cursor >= wantEnd) return true;
  }
  return cursor >= wantEnd;
}

// Returns the current location for a session from Google Sheets, or null if not found / unchanged.
export async function getCurrentSheetLocation(date: string, startTime: string): Promise<string | null> {
  const [weeklySessions, privateSlots] = await Promise.all([
    getWeeklySchedule().catch(() => []),
    getPrivateSlots().catch(() => []),
  ]);
  for (const s of [...weeklySessions, ...privateSlots]) {
    if (s.date === date && s.startTime === startTime) return s.location;
  }
  return null;
}
