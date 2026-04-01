import { NextResponse } from "next/server";
import { getWeeklySchedule, getCamps } from "@/lib/sheets";
import { upsertGroupSessionCalendarEvent } from "@/lib/calendar";

export async function GET() {
  const today = new Date().toISOString().split("T")[0];
  let synced = 0;
  let errors = 0;
  const log: string[] = [];

  try {
    const sessions = await getWeeklySchedule();
    for (const session of sessions) {
      if (!session.date || session.date < today) continue;
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
        log.push(`✓ Group: ${session.group} on ${session.date}`);
        synced++;
      } catch (err) {
        log.push(`✗ Group: ${session.group} on ${session.date} — ${err}`);
        errors++;
      }
    }
  } catch (err) {
    log.push(`✗ Failed to fetch weekly schedule: ${err}`);
  }

  try {
    const camps = await getCamps();
    for (const camp of camps) {
      if (!camp.campDays || camp.campDays.length === 0) {
        if (!camp.startDate || camp.startDate < today) continue;
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "camp",
            sessionLabel: camp.name,
            bookedDate: camp.startDate,
            bookedStartTime: camp.time,
            bookedEndTime: camp.time,
            bookedLocation: camp.location,
            maxSpots: camp.maxSpots,
            kidsJustRegistered: "",
            participantsJustRegistered: 0,
          });
          log.push(`✓ Camp: ${camp.name} on ${camp.startDate}`);
          synced++;
        } catch (err) {
          log.push(`✗ Camp: ${camp.name} on ${camp.startDate} — ${err}`);
          errors++;
        }
      } else {
        for (const day of camp.campDays) {
          if (!day || day < today) continue;
          try {
            await upsertGroupSessionCalendarEvent({
              sessionType: "camp",
              sessionLabel: camp.name,
              bookedDate: day,
              bookedStartTime: camp.time,
              bookedEndTime: camp.time,
              bookedLocation: camp.location,
              maxSpots: camp.maxSpots,
              kidsJustRegistered: "",
              participantsJustRegistered: 0,
            });
            log.push(`✓ Camp day: ${camp.name} on ${day}`);
            synced++;
          } catch (err) {
            log.push(`✗ Camp day: ${camp.name} on ${day} — ${err}`);
            errors++;
          }
        }
      }
    }
  } catch (err) {
    log.push(`✗ Failed to fetch camps: ${err}`);
  }

  return NextResponse.json({ synced, errors, log });
}
