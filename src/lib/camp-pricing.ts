// Camp pricing rules shared by the schedule page and /api/register, so the
// price a parent sees is exactly the price the server charges.

// Midnight Eastern at the start of the day AFTER y-m-d, as a UTC instant.
// Tries both Eastern offsets (EST -5, EDT -4) and keeps the one that really
// is 00:00 in New York, so it is right on either side of a DST change.
function easternMidnightAfter(y: number, m: number, d: number): Date {
  for (const offset of [5, 4]) {
    const t = new Date(Date.UTC(y, m - 1, d + 1, offset));
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(t);
    if (Number(hour) === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 5));
}

// The sheet's Early Bird Deadline cell ("December 14, 2026", "12/14/2026" or
// "2026-12-14") → the instant early bird ends (end of that day, Eastern).
// Blank or unreadable → null, meaning no early bird.
export function earlyBirdEnds(deadline: string | undefined): Date | null {
  const raw = (deadline || "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const d = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : new Date(raw + " 12:00:00");
  if (isNaN(d.getTime()) || d.getFullYear() < 2020) return null;
  return easternMidnightAfter(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function isEarlyBirdActive(camp: { earlyBirdPrice: string; earlyBirdDeadline?: string }, now: Date = new Date()): boolean {
  const ends = earlyBirdEnds(camp.earlyBirdDeadline);
  return !!camp.earlyBirdPrice.trim() && !!ends && now < ends;
}

// "Dec 14" for the "Early Bird — ends …" label.
export function earlyBirdEndsLabel(camp: { earlyBirdDeadline?: string }): string {
  const ends = earlyBirdEnds(camp.earlyBirdDeadline);
  if (!ends) return "";
  return new Date(ends.getTime() - 1).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

// A camp with no Drop-In Price is sold as the full camp only.
export function isFullCampOnly(camp: { dropInPrice: string }): boolean {
  return !camp.dropInPrice.trim();
}

// The price shown/charged for the full camp right now (early bird if active).
export function fullCampPrice(camp: { price: string; earlyBirdPrice: string; earlyBirdDeadline?: string }, now: Date = new Date()): string {
  return isEarlyBirdActive(camp, now) ? camp.earlyBirdPrice : camp.price;
}
