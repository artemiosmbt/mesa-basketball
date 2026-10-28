/**
 * Checks on buildWeeklyPlan — how a sheet edit to a group session is read:
 * a time/location change (move the players), a deleted session (cancel and
 * refund them), or something unclear (text Artemios, touch nothing).
 *
 * Pure function, no database, no Sheets:
 *   npx tsx tools/test-weekly-time-change.mjs
 *
 * The case that started it (2026-10-28): changing a group session's time on
 * the sheet cancelled one player. Players were moved to the new time one at
 * a time; a second sync that ran before the first finished saw some already
 * at the new time and the rest at the old one, and read the rest as a
 * deleted session.
 */
import { buildWeeklyPlan } from "../src/lib/weekly-schedule-matching.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

const D = "11/4/2026";
const row = (group, start, end, location = "Mesa Gym", date = D) => ({ group, date, startTime: start, endTime: end, location, maxSpots: 8, price: 50, trainer: "Artemios Gavalas" });
let n = 0;
const reg = (group, start, end, location = "Mesa Gym", date = D) => ({ id: `r${++n}`, booked_date: date, booked_start_time: start, booked_end_time: end, booked_location: location, booked_group: group, session_details: `${group} — ${date} ${start}-${end} at ${location}` });
// The cron passes only upcoming rows with a start time, plus the whole sheet.
const plan = (sheet, regs) => {
  const p = buildWeeklyPlan(sheet.filter((s) => s.startTime && s.group), regs, sheet);
  return {
    changes: p.changes.map((c) => `${c.reg.id}->${c.newSession.startTime}`),
    deletions: p.deletions.map((r) => r.id),
    ambiguous: p.ambiguous.map((a) => a.regCount),
  };
};

console.log("\ntime changes");
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM"), reg("Varsity", "6:00 PM", "7:00 PM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("6-7 moved to 6:30-7:30: all three players move, nobody cancelled",
    plan([row("Varsity", "6:30 PM", "7:30 PM")], regs),
    { changes: ["r1->6:30 PM", "r2->6:30 PM", "r3->6:30 PM"], deletions: [], ambiguous: [] });
}
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM")];
  check("start edited first (end not yet): moves to the half-edited time, no cancel",
    plan([row("Varsity", "6:30 PM", "7:00 PM")], regs),
    { changes: ["r1->6:30 PM"], deletions: [], ambiguous: [] });
}
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM")];
  check("time and location changed together",
    plan([row("Varsity", "7:00 PM", "8:00 PM", "Other Gym")], regs),
    { changes: ["r1->7:00 PM"], deletions: [], ambiguous: [] });
}
{
  n = 0;
  const regs = [reg("varsity ", "6:00 PM", "7:00 PM")];
  check("group typed with different case/spacing still matches",
    plan([row("Varsity", "6:30 PM", "7:30 PM")], regs),
    { changes: ["r1->6:30 PM"], deletions: [], ambiguous: [] });
}

console.log("\nthe real case: a second sync sees the session half-moved");
{
  n = 0;
  const regs = [reg("Varsity", "6:30 PM", "7:30 PM"), reg("Varsity", "6:30 PM", "7:30 PM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("two players already at the new time, one still at the old: nobody cancelled, flagged",
    plan([row("Varsity", "6:30 PM", "7:30 PM")], regs),
    { changes: [], deletions: [], ambiguous: [1] });
}

console.log("\nmid-edit and rename");
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("time cell blank while being retyped: nobody cancelled",
    plan([row("Varsity", "", "")], regs),
    { changes: [], deletions: [], ambiguous: [2] });
}
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM")];
  check("group renamed in the same edit (same time and gym): nobody cancelled",
    plan([row("Varsity Boys", "6:00 PM", "7:00 PM")], regs),
    { changes: [], deletions: [], ambiguous: [1] });
}

console.log("\nreal deletions still cancel");
{
  n = 0;
  const regs = [reg("Varsity", "6:00 PM", "7:00 PM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("row removed from the sheet: both bookings cancelled",
    plan([row("JV", "5:00 PM", "6:00 PM")], regs),
    { changes: [], deletions: ["r1", "r2"], ambiguous: [] });
}

console.log("\nsame group twice in one day");
{
  n = 0;
  const regs = [reg("Varsity", "9:00 AM", "10:00 AM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("PM session moved, AM untouched: only the PM player moves",
    plan([row("Varsity", "9:00 AM", "10:00 AM"), row("Varsity", "6:30 PM", "7:30 PM")], regs),
    { changes: ["r2->6:30 PM"], deletions: [], ambiguous: [] });
}
{
  n = 0;
  const regs = [reg("Varsity", "9:00 AM", "10:00 AM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("both moved at once: can't tell which is which, flagged, nothing moved or cancelled",
    plan([row("Varsity", "9:30 AM", "10:30 AM"), row("Varsity", "6:30 PM", "7:30 PM")], regs),
    { changes: [], deletions: [], ambiguous: [2] });
}
{
  n = 0;
  const regs = [reg("Varsity", "9:00 AM", "10:00 AM"), reg("Varsity", "6:00 PM", "7:00 PM")];
  check("PM row removed while AM stays: flagged for review, not auto-cancelled",
    plan([row("Varsity", "9:00 AM", "10:00 AM")], regs),
    { changes: [], deletions: [], ambiguous: [1] });
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
