// Converts an America/New_York wall-clock date+time into the real absolute
// UTC instant it represents — safe to compare against Date.now() no matter
// what timezone the code is actually executing in (a server, or a browser
// anywhere in the world). Session times are always meant as ET wall-clock
// time; naively doing `new Date(dateStr); d.setHours(h, m)` instead sets
// the hour in whatever timezone the CODE is running in, which is wrong the
// moment that's not America/New_York — this exact pattern was confirmed
// live from Athens to silently mis-time "has this session passed?" checks
// on the admin dashboard (its original sessionMs bug, fixed separately).
//
// "Double conversion" trick to get the ET offset without a timezone
// database: guess the UTC instant as if the wall-clock numbers WERE UTC,
// check what ET wall-clock time that guess actually renders as, then shift
// by the difference. Naturally picks up EDT vs EST for the date in question.
export function etWallClockToMs(y: number, m: number, d: number, h: number, min: number): number {
  const guessMs = Date.UTC(y, m - 1, d, h, min);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(guessMs));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0", 10);
  const seenAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return guessMs + (guessMs - seenAsUTC);
}

// Today's calendar date in America/New_York, regardless of what timezone
// the code is actually running in — for "is this date in the past" filters
// that should follow the business's calendar day, not the viewer's own.
export function todayET(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0", 10);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Parses a "7:30 PM" style time string into 24-hour {hours, mins}, or null
// if it doesn't match. Shared here since every caller of etWallClockToMs
// needs this same extraction before it can call it.
export function parseTimeOfDay(timeStr: string): { hours: number; mins: number } | null {
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return { hours, mins };
}
