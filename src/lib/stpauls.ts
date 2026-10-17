// St. Paul's team practices — church teams hire a Mesa trainer to run a
// 1-hour practice inside the church's practice blocks. Entirely separate
// from registrations: no Stripe, not in payroll, not in the admin
// Upcoming/Past/Calendar/Payments tabs. The coach pays the trainer $60 in
// cash at practice. Shared by the coach page, the admin tab and the API
// routes, so it must stay free of secrets (it ships in client bundles).

export const STPAULS_PATH = "/stpauls-practices";
export const STPAULS_PRICE = 60;
export const STPAULS_LOCATION = "St. Paul's Cathedral";
export const STPAULS_SESSION_LABEL = "St. Paul's Team Practice";

// First day practices can be booked (the church's season start).
export const STPAULS_SEASON_START = "2026-10-19";
// How far ahead coaches can book, in weeks from today.
export const STPAULS_WEEKS_AHEAD = 12;
export const STPAULS_PRACTICE_MINUTES = 60;
export const STPAULS_SLOT_STEP_MINUTES = 30;

// The church's practice blocks, by weekday (0 = Sunday). A practice is one
// hour and can start on any half hour that still ends inside the block.
export const STPAULS_BLOCKS: { dow: number; start: string; end: string }[] = [
  { dow: 1, start: "17:00", end: "19:00" }, // Monday 5–7 pm
  { dow: 3, start: "17:00", end: "22:30" }, // Wednesday 5–10:30 pm
  { dow: 4, start: "17:30", end: "20:30" }, // Thursday 5:30–8:30 pm
  { dow: 5, start: "17:00", end: "19:00" }, // Friday 5–7 pm
];

export interface StPaulsCoach {
  name: string;
  phone: string;
  email: string;
}

export interface StPaulsPractice {
  id: string;
  practice_date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  team_name: string;
  coaches: StPaulsCoach[];
  booked_by_email: string;
  booked_by_name: string | null;
  assigned_trainer: string | null;
  status: "booked" | "cancelled";
  created_at: string;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// "17:30" → "5:30 PM"
export function formatTime12(hhmm: string): string {
  const min = toMinutes(hhmm);
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

// Date math on plain YYYY-MM-DD strings at UTC noon, so no device timezone
// or DST shift can move a date by a day.
function parseDate(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}
export function addDays(ymd: string, n: number): string {
  const d = parseDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayOfWeek(ymd: string): number {
  return parseDate(ymd).getUTCDay();
}
// "Wed, Oct 22"
export function formatDateShort(ymd: string): string {
  return parseDate(ymd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
// "Wednesday, October 22"
export function formatDateLong(ymd: string): string {
  return parseDate(ymd).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
// The Monday on or before this date.
export function weekStart(ymd: string): string {
  return addDays(ymd, -((dayOfWeek(ymd) + 6) % 7));
}

// The gym is on Long Island, so "today" and "now" are New York time no
// matter where the server or the viewer is.
export function nyNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function blockForDate(ymd: string) {
  return STPAULS_BLOCKS.find((b) => b.dow === dayOfWeek(ymd)) || null;
}

// Every valid 1-hour start time on this date, ignoring what's booked.
export function startTimesForDate(ymd: string): string[] {
  const block = blockForDate(ymd);
  if (!block) return [];
  const out: string[] = [];
  for (let m = toMinutes(block.start); m + STPAULS_PRACTICE_MINUTES <= toMinutes(block.end); m += STPAULS_SLOT_STEP_MINUTES) {
    out.push(fromMinutes(m));
  }
  return out;
}

// First and last bookable dates: from the later of the season start and
// today, through STPAULS_WEEKS_AHEAD weeks out.
export function bookableRange(): { from: string; to: string } {
  const today = nyNow().date;
  const from = today > STPAULS_SEASON_START ? today : STPAULS_SEASON_START;
  return { from, to: addDays(today, STPAULS_WEEKS_AHEAD * 7) };
}

// Server-side check that a requested practice is a real slot: inside a
// block, on a half hour, in the bookable range, and not already started.
export function validateSlot(date: string, start: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) return "Invalid date or time.";
  if (!startTimesForDate(date).includes(start)) return `${formatDateShort(date)} at ${formatTime12(start)} isn't one of the practice times.`;
  const { from, to } = bookableRange();
  if (date < from || date > to) return `${formatDateShort(date)} can't be booked right now.`;
  const now = nyNow();
  if (date === now.date && toMinutes(start) <= now.minutes) return `${formatDateShort(date)} at ${formatTime12(start)} has already started.`;
  return null;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

export function practiceEnd(start: string): string {
  return fromMinutes(toMinutes(start) + STPAULS_PRACTICE_MINUTES);
}
