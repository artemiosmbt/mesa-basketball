import { NextResponse } from "next/server";
import { getWeeklySchedule, getCamps } from "@/lib/sheets";
import { upsertGroupSessionCalendarEvent } from "@/lib/calendar";

function splitTime(time: string): { start: string; end: string } {
  const parts = time.split(/\s*[-–]\s*/);
  return { start: parts[0]?.trim() || time, end: parts[1]?.trim() || parts[0]?.trim() || time };
}

export async function GET() {
  const today = new Date().toISOString().split("T")[0];
  const tasks: Promise<{ label: string; ok: boolean }>[] = [];

  const [sessions, camps] = await Promise.all([getWeeklySchedule(), getCamps()]);

  for (const session of sessions) {
    if (!session.date || session.date < today) continue;
    tasks.push(
      upsertGroupSessionCalendarEvent({
        sessionType: "weekly",
        sessionLabel: session.group || "Group Session",
        bookedDate: session.date,
        bookedStartTime: session.startTime,
        bookedEndTime: session.endTime,
        bookedLocation: session.location,
        maxSpots: session.maxSpots,
        kidsJustRegistered: "",
        participantsJustRegistered: 0,
      })
        .then(() => ({ label: `✓ Group: ${session.group} on ${session.date}`, ok: true }))
        .catch((err) => ({ label: `✗ Group: ${session.group} on ${session.date} — ${err}`, ok: false }))
    );
  }

  for (const camp of camps) {
    const { start: campStart, end: campEnd } = splitTime(camp.time);
    const days = camp.campDays?.length ? camp.campDays : [camp.startDate];
    for (const day of days) {
      if (!day || day < today) continue;
      tasks.push(
        upsertGroupSessionCalendarEvent({
          sessionType: "camp",
          sessionLabel: camp.name,
          bookedDate: day,
          bookedStartTime: campStart,
          bookedEndTime: campEnd,
          bookedLocation: camp.location,
          maxSpots: camp.maxSpots,
          kidsJustRegistered: "",
          participantsJustRegistered: 0,
        })
          .then(() => ({ label: `✓ Camp: ${camp.name} on ${day}`, ok: true }))
          .catch((err) => ({ label: `✗ Camp: ${camp.name} on ${day} — ${err}`, ok: false }))
      );
    }
  }

  const results = await Promise.all(tasks);
  const log = results.map((r) => r.label);
  const synced = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => !r.ok).length;

  return NextResponse.json({ synced, errors, log });
}
