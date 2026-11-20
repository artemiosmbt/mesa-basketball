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
  // multi-group camp fields (optional — col K-O)
  gradeGroup: string;
  earlyBirdPrice: string;
  dropInPrice: string; // blank = full camp only, no single days
  campDays: string[];
  earlyBirdDeadline: string; // col O; blank = no early bird
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

// strict: for the time-change / deletion sync only. A failed or garbled
// read (an HTTP error, Google's HTML error page, an empty body) must never be
// taken as "every session is gone" — that would cancel and refund real
// bookings. Throws instead, so the caller does nothing this run.
export async function getWeeklySchedule(options?: { noCache?: boolean; strict?: boolean }): Promise<WeeklySession[]> {
  const url = process.env.SHEET_CSV_WEEKLY_SCHEDULE;
  if (!url) {
    if (options?.strict) throw new Error("SHEET_CSV_WEEKLY_SCHEDULE is not set");
    console.error("SHEET_CSV_WEEKLY_SCHEDULE is not set — returning an empty schedule instead of the real one.");
    return [];
  }
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const text = await res.text();
  if (options?.strict) {
    if (!res.ok) throw new Error(`Weekly schedule fetch failed: HTTP ${res.status}`);
    if (/^\s*</.test(text)) throw new Error("Weekly schedule fetch returned HTML, not CSV");
  }
  const rows = parseCSV(text);
  if (options?.strict && !rows.slice(1).some((r) => (r[0] || "").trim() && (r[1] || "").trim())) {
    throw new Error("Weekly schedule fetch returned no sessions");
  }
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

// Camps tab columns are found by their header text, so they can be in any
// order. Recognised headers (case and punctuation ignored):
//   Name of Camp | Grades/Age Group | Start Date | End Date | Time | Location |
//   Max Spots | Early Bird Price | Early Bird End Date | Regular Price |
//   Description | Notify
// Optional: Drop-In Price (per day; blank = full camp only), Camp Days
// ("Dec 28, 2026 | Dec 29, 2026"; blank = every day from Start to End Date),
// Current Enrolled.
const CAMP_HEADERS: Record<string, string[]> = {
  name: ["nameofcamp", "campname", "name"],
  gradeGroup: ["gradesagegroup", "gradeagegroup", "grades", "agegroup", "gradegroup", "group"],
  startDate: ["startdate"],
  endDate: ["enddate"],
  time: ["time"],
  location: ["location"],
  maxSpots: ["maxspots", "spots"],
  currentEnrolled: ["currentenrolled", "enrolled"],
  earlyBirdPrice: ["earlybirdprice", "earlybird"],
  earlyBirdDeadline: ["earlybirdenddate", "earlybirddeadline", "earlybirdends"],
  price: ["regularprice", "price"],
  dropInPrice: ["dropinprice", "perdayprice", "dropin"],
  campDays: ["campdays", "days"],
  description: ["description"],
  notify: ["notify"],
};

// Every day from start to end inclusive, as "December 28, 2026". Empty when
// either date can't be read (e.g. "April 2-3 & 6-7, 2026") or the range is
// longer than three weeks — those camps list their days in Camp Days instead.
function daysBetween(start: string, end: string): string[] {
  const parse = (v: string) => {
    const iso = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const d = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3], 12) : new Date(v.trim() + " 12:00:00");
    return isNaN(d.getTime()) || d.getFullYear() < 2020 ? null : d;
  };
  const a = parse(start);
  const b = parse(end || start);
  if (!a || !b || b < a) return [];
  const out: string[] = [];
  for (const d = new Date(a); d <= b && out.length <= 21; d.setDate(d.getDate() + 1)) {
    out.push(d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
  }
  return out.length > 21 ? [] : out;
}

// "12:00-3:00 PM" → "12:00 PM-3:00 PM". Bookings store the start time on its
// own, and the 24-hour cancellation rule, the camp-started lock and capacity
// all need its AM/PM. A start without one takes the end's, unless that would
// put it after the end ("11:00-1:00 PM" → 11:00 AM).
function normalizeCampTime(time: string): string {
  const m = time.match(/^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*$/i);
  if (!m) return time;
  const [, sh, sm = "00", sp, eh, em = "00", ep] = m;
  let startPeriod = sp?.toUpperCase();
  if (!startPeriod) {
    const s12 = parseInt(sh) % 12, e12 = parseInt(eh) % 12;
    startPeriod = s12 > e12 ? (ep.toUpperCase() === "PM" ? "AM" : "PM") : ep.toUpperCase();
  }
  return `${parseInt(sh)}:${sm} ${startPeriod}-${parseInt(eh)}:${em} ${ep.toUpperCase()}`;
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
  const header = (rows[0] || []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const col: Record<string, number> = {};
  for (const [field, names] of Object.entries(CAMP_HEADERS)) {
    const i = names.map((n) => header.indexOf(n)).find((x) => x !== -1);
    if (i !== undefined) col[field] = i;
  }
  return rows.slice(1).map((row, i) => {
    const get = (field: string) => (col[field] === undefined ? "" : (row[col[field]] || "").trim());
    const listed = get("campDays").split("|").map((d) => d.trim()).filter(Boolean);
    return {
      id: `camp-${i}`,
      name: get("name"),
      startDate: get("startDate"),
      endDate: get("endDate"),
      time: normalizeCampTime(get("time")),
      location: get("location"),
      maxSpots: parseInt(get("maxSpots")) || 20,
      currentEnrolled: parseInt(get("currentEnrolled")) || 0,
      price: get("price"),
      description: get("description"),
      notify: get("notify").toUpperCase() === "TRUE",
      gradeGroup: get("gradeGroup"),
      earlyBirdPrice: get("earlyBirdPrice"),
      dropInPrice: get("dropInPrice"),
      campDays: listed.length ? listed : daysBetween(get("startDate"), get("endDate")),
      earlyBirdDeadline: get("earlyBirdDeadline"),
    };
  }).filter((camp) => camp.name);
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
