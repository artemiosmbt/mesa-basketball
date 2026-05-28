import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule } from "@/lib/sheets";
import { sendTimeChangeNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay } from "@/lib/sms";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Only check upcoming sessions
  const today = new Date().toISOString().split("T")[0];

  let sessions;
  try {
    sessions = await getWeeklySchedule();
  } catch (err) {
    console.error("detect-time-changes: failed to fetch schedule", err);
    return NextResponse.json({ error: "Failed to fetch schedule" }, { status: 500 });
  }

  const upcoming = sessions.filter(
    (s) => s.date >= today && s.startTime && s.group
  );

  const changesDetected: string[] = [];
  let totalRegistrantsNotified = 0;
  let totalEmailsSent = 0;
  let totalSmsSent = 0;

  for (const session of upcoming) {
    // Find confirmed weekly registrations for this date + group where the stored
    // start time no longer matches the sheet. The group name in session_details
    // lets us handle multiple sessions on the same day correctly.
    const { data: stale, error } = await supabase
      .from("registrations")
      .select("*")
      .eq("booked_date", session.date)
      .eq("type", "weekly")
      .eq("status", "confirmed")
      .neq("booked_start_time", session.startTime)
      .ilike("session_details", `%${session.group}%`);

    if (error) {
      console.error("detect-time-changes DB error", session.date, session.group, error);
      continue;
    }

    if (!stale || stale.length === 0) continue;

    // Grab the old time from the first stale record (all will share it)
    const oldStartTime: string = stale[0].booked_start_time;
    const oldEndTime: string = stale[0].booked_end_time || oldStartTime;

    changesDetected.push(
      `${session.date} "${session.group}": ${oldStartTime} → ${session.startTime}`
    );

    for (const r of stale) {
      // Fix the time stored in session_details text
      const newDetails = (r.session_details || "")
        .replace(
          `${r.booked_start_time}-${r.booked_end_time}`,
          `${session.startTime}-${session.endTime}`
        )
        .replace(
          `${r.booked_start_time}–${r.booked_end_time}`,
          `${session.startTime}–${session.endTime}`
        );

      // Update the DB record — admin dashboard and My Bookings now show new time
      await supabase
        .from("registrations")
        .update({
          booked_start_time: session.startTime,
          booked_end_time: session.endTime,
          session_details: newDetails,
        })
        .eq("id", r.id);

      // Email every registrant
      try {
        await sendTimeChangeNotification({
          parentName: r.parent_name,
          email: r.email,
          kids: r.kids,
          date: session.date,
          sessionLabel: session.group,
          oldStartTime,
          oldEndTime,
          newStartTime: session.startTime,
          newEndTime: session.endTime,
          location: r.booked_location || session.location,
        });
        totalEmailsSent++;
      } catch (err) {
        console.error("Time change email failed for", r.email, err);
      }

      // SMS for anyone who opted in
      if (r.sms_consent) {
        const dateStr = formatDateWithDay(session.date);
        const smsBody =
          `Mesa Basketball: ${dateStr} time update. ${session.group}: ` +
          `now ${session.startTime}-${session.endTime} (was ${oldStartTime}-${oldEndTime}). ` +
          `Same location. Questions? (631) 599-1280. Reply STOP to opt out.`;
        try {
          await sendSMS(r.phone, smsBody);
          totalSmsSent++;
        } catch (err) {
          console.error("Time change SMS failed for", r.phone, err);
        }
      }

      totalRegistrantsNotified++;
    }
  }

  // Send one admin SMS summarising everything that changed
  if (changesDetected.length > 0) {
    const summary = changesDetected.map((c) => `• ${c}`).join("\n");
    await sendAdminSMS(
      `TIME CHANGE AUTO-DETECTED:\n${summary}\n` +
        `${totalRegistrantsNotified} registrant${totalRegistrantsNotified !== 1 ? "s" : ""} notified ` +
        `(${totalEmailsSent} email, ${totalSmsSent} SMS)`
    );
  }

  return NextResponse.json({
    checked: upcoming.length,
    changesDetected,
    totalRegistrantsNotified,
    totalEmailsSent,
    totalSmsSent,
  });
}
