import { NextResponse } from "next/server";
import { getWeeklySchedule, getCamps, getPrivateSlots } from "@/lib/sheets";
import { getBookedSlots, getGroupSessionEnrollment } from "@/lib/supabase";

import {
  demoWeeklySchedule,
  demoCamps,
  demoPrivateSlots,
} from "@/lib/demo-data";

export const dynamic = "force-dynamic";

// Returns current time components in Eastern Time (runs server-side, always correct).
function getNowET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? "0");
  const hour = get("hour") % 24;
  return { year: get("year"), month: get("month"), day: get("day"), totalMins: hour * 60 + get("minute") };
}

function parseTimeMins(t: string): number {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

// Is this session (date + startTime) in the future relative to ET now?
// Date strings from the sheet can be "June 15, 2026" or "2026-06-15".
// Server runs in UTC so "June 15, 2026 12:00:00" parses as UTC noon → correct date components.
function isUpcoming(dateStr: string, startTime: string, et: ReturnType<typeof getNowET>): boolean {
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let sy: number, sm: number, sd: number;
  if (iso) {
    sy = parseInt(iso[1]); sm = parseInt(iso[2]); sd = parseInt(iso[3]);
  } else {
    const d = new Date(dateStr + " 12:00:00"); // noon UTC on server
    if (isNaN(d.getTime())) return false;
    sy = d.getUTCFullYear(); sm = d.getUTCMonth() + 1; sd = d.getUTCDate();
  }
  if (sy !== et.year || sm !== et.month || sd !== et.day) {
    return new Date(sy, sm - 1, sd) > new Date(et.year, et.month - 1, et.day);
  }
  return parseTimeMins(startTime) > et.totalMins;
}

export async function GET() {
  const hasSheets =
    process.env.SHEET_CSV_WEEKLY_SCHEDULE ||
    process.env.SHEET_CSV_CAMPS ||
    process.env.SHEET_CSV_PRIVATE_SLOTS;

  if (!hasSheets) {
    return NextResponse.json({
      weeklySchedule: demoWeeklySchedule,
      camps: demoCamps,
      privateSlots: demoPrivateSlots,
      bookedSlots: [],
      groupEnrollment: {},
      demo: true,
    });
  }

  try {
    const [weeklySchedule, camps, privateSlots, bookedSlots, groupEnrollment] =
      await Promise.all([
        getWeeklySchedule(),
        getCamps(),
        getPrivateSlots(),
        getBookedSlots().catch(() => []),
        getGroupSessionEnrollment().catch(() => ({})),
      ]);

    const et = getNowET();

    return NextResponse.json({
      weeklySchedule: weeklySchedule.filter(s => isUpcoming(s.date, s.startTime, et)),
      camps,
      privateSlots: privateSlots.filter(s => s.available && isUpcoming(s.date, s.startTime, et)),
      bookedSlots,
      groupEnrollment,
    });
  } catch (error) {
    console.error("Error fetching schedule:", error);
    return NextResponse.json({
      weeklySchedule: demoWeeklySchedule,
      camps: demoCamps,
      privateSlots: demoPrivateSlots,
      bookedSlots: [],
      groupEnrollment: {},
      demo: true,
    });
  }
}
