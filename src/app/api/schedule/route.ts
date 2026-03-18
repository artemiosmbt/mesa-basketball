import { NextResponse } from "next/server";
import { getWeeklySchedule, getCamps, getPrivateSlots } from "@/lib/sheets";
import {
  demoWeeklySchedule,
  demoCamps,
  demoPrivateSlots,
} from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export async function GET() {
  // If Google Sheets isn't configured, return demo data
  const hasSheets =
    process.env.SHEET_CSV_WEEKLY_SCHEDULE ||
    process.env.SHEET_CSV_CAMPS ||
    process.env.SHEET_CSV_PRIVATE_SLOTS;

  if (!hasSheets) {
    return NextResponse.json({
      weeklySchedule: demoWeeklySchedule,
      camps: demoCamps,
      privateSlots: demoPrivateSlots,
      demo: true,
    });
  }

  try {
    const [weeklySchedule, camps, privateSlots] = await Promise.all([
      getWeeklySchedule(),
      getCamps(),
      getPrivateSlots(),
    ]);

    return NextResponse.json({
      weeklySchedule,
      camps,
      privateSlots: privateSlots.filter((s) => s.available),
    });
  } catch (error) {
    console.error("Error fetching schedule:", error);
    // Fall back to demo data on error
    return NextResponse.json({
      weeklySchedule: demoWeeklySchedule,
      camps: demoCamps,
      privateSlots: demoPrivateSlots,
      demo: true,
    });
  }
}
