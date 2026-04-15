import { NextRequest, NextResponse } from "next/server";
import { getWeeklySchedule, getCamps } from "@/lib/sheets";
import { upsertGroupSessionCalendarEvent, deleteStaleGroupSessionEvents } from "@/lib/calendar";

function splitTime(time: string): { start: string; end: string } {
  const parts = time.split(/\s*[-–]\s*/);
  return { start: parts[0]?.trim() || time, end: parts[1]?.trim() || parts[0]?.trim() || time };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().split("T")[0];
  let synced = 0;
  let errors = 0;
  const errorDetails: string[] = [];

  // Build a set of expected tags from the current schedule so we can clean up stale events
  const expectedTags = new Set<string>();

  // Sync all upcoming weekly group sessions
  try {
    const sessions = await getWeeklySchedule();
    for (const session of sessions) {
      if (!session.date || session.date < today) continue;
      expectedTags.add(`[mesa-session:${session.date}|${session.startTime}]`);
      try {
        await upsertGroupSessionCalendarEvent({
          sessionType: "weekly",
          sessionLabel: session.group || "Group Session",
          bookedDate: session.date,
          bookedStartTime: session.startTime,
          bookedEndTime: session.endTime,
          bookedLocation: session.location,
          maxSpots: session.maxSpots,
          kidsJustRegistered: "",
          participantsJustRegistered: 0,
        });
        synced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Calendar sync error (weekly ${session.date}):`, err);
        errorDetails.push(`weekly ${session.date} ${session.startTime} (${session.group}): ${msg}`);
        errors++;
      }
    }
  } catch (err) {
    console.error("Failed to fetch weekly schedule:", err);
  }

  // Sync all upcoming camp sessions
  try {
    const camps = await getCamps();
    for (const camp of camps) {
      const { start: campStart, end: campEnd } = splitTime(camp.time);
      if (!camp.campDays || camp.campDays.length === 0) {
        if (!camp.startDate || camp.startDate < today) continue;
        expectedTags.add(`[mesa-session:${camp.startDate}|${campStart}]`);
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "camp",
            sessionLabel: camp.name,
            bookedDate: camp.startDate,
            bookedStartTime: campStart,
            bookedEndTime: campEnd,
            bookedLocation: camp.location,
            maxSpots: camp.maxSpots,
            kidsJustRegistered: "",
            participantsJustRegistered: 0,
          });
          synced++;
        } catch (err) {
          console.error(`Calendar sync error (camp ${camp.startDate}):`, err);
          errors++;
        }
      } else {
        for (const day of camp.campDays) {
          if (!day || day < today) continue;
          expectedTags.add(`[mesa-session:${day}|${campStart}]`);
          try {
            await upsertGroupSessionCalendarEvent({
              sessionType: "camp",
              sessionLabel: camp.name,
              bookedDate: day,
              bookedStartTime: campStart,
              bookedEndTime: campEnd,
              bookedLocation: camp.location,
              maxSpots: camp.maxSpots,
              kidsJustRegistered: "",
              participantsJustRegistered: 0,
            });
            synced++;
          } catch (err) {
            console.error(`Calendar sync error (camp day ${day}):`, err);
            errors++;
          }
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch camps:", err);
  }

  // Delete any future calendar events that are no longer in the schedule
  let deleted = 0;
  try {
    const result = await deleteStaleGroupSessionEvents(expectedTags);
    deleted = result.deleted;
  } catch (err) {
    console.error("Failed to clean up stale calendar events:", err);
  }

  return NextResponse.json({ synced, errors, deleted, errorDetails });
}
