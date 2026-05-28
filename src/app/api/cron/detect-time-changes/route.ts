import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getWeeklySchedule } from "@/lib/sheets";
import { sendTimeChangeNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";

function sessionIsUpcoming(dateStr: string, startTimeStr: string): boolean {
  try {
    const now = new Date();
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const getP = (t: string) => etParts.find((p) => p.type === t)?.value ?? "0";
    const todayISO = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const nowMinutes = parseInt(getP("hour")) * 60 + parseInt(getP("minute"));

    const sd = new Date(dateStr);
    if (isNaN(sd.getTime())) return true;
    const sessionISO = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, "0")}-${String(sd.getDate()).padStart(2, "0")}`;

    if (sessionISO > todayISO) return true;
    if (sessionISO < todayISO) return false;

    // Same day — only notify if session hasn't started yet
    const match = startTimeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return true;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + m > nowMinutes;
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let sessions;
  try {
    sessions = await getWeeklySchedule({ noCache: true });
  } catch (err) {
    console.error("detect-time-changes: failed to fetch schedule", err);
    return NextResponse.json({ error: "Failed to fetch schedule" }, { status: 500 });
  }

  const upcoming = sessions.filter(
    (s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group
  );

  const changesDetected: string[] = [];
  let totalRegistrantsNotified = 0;
  let totalEmailsSent = 0;
  let totalSmsSent = 0;

  for (const session of upcoming) {
    // Get all confirmed weekly registrations for this date+group
    const { data: allRegs, error } = await supabase
      .from("registrations")
      .select("*")
      .eq("booked_date", session.date)
      .eq("type", "weekly")
      .eq("status", "confirmed")
      .ilike("session_details", `%${session.group}%`);

    if (error) {
      console.error("detect-time-changes DB error", session.date, session.group, error);
      continue;
    }

    // Filter to those where time or location no longer matches the sheet
    const stale = (allRegs || []).filter(
      (r) => r.booked_start_time !== session.startTime || r.booked_location !== session.location
    );

    if (stale.length === 0) continue;

    const firstOldStart: string = stale[0].booked_start_time;
    const timeChangedAny = stale.some((r) => r.booked_start_time !== session.startTime);
    const locationChangedAny = stale.some((r) => r.booked_location !== session.location);
    let changeDesc = `${session.date} "${session.group}"`;
    if (timeChangedAny) changeDesc += `: ${firstOldStart} → ${session.startTime}`;
    if (locationChangedAny) changeDesc += ` (location changed)`;
    changesDetected.push(changeDesc);

    for (const r of stale) {
      const timeChanged = r.booked_start_time !== session.startTime;
      const locationChanged = r.booked_location !== session.location;
      const changeType: "time" | "location" | "both" =
        timeChanged && locationChanged ? "both" : timeChanged ? "time" : "location";

      const rOldStart: string = r.booked_start_time;
      const rOldEnd: string = r.booked_end_time || rOldStart;
      const rOldLocation: string = r.booked_location || "";

      // Update session_details text
      let newDetails = r.session_details || "";
      if (timeChanged) {
        newDetails = newDetails
          .replace(`${rOldStart}-${rOldEnd}`, `${session.startTime}-${session.endTime}`)
          .replace(`${rOldStart}–${rOldEnd}`, `${session.startTime}–${session.endTime}`);
      }
      if (locationChanged && rOldLocation) {
        newDetails = newDetails.replace(`at ${rOldLocation}`, `at ${session.location}`);
      }

      await supabase
        .from("registrations")
        .update({
          booked_start_time: session.startTime,
          booked_end_time: session.endTime,
          ...(locationChanged ? { booked_location: session.location } : {}),
          session_details: newDetails,
        })
        .eq("id", r.id);

      // Email
      try {
        await sendTimeChangeNotification({
          parentName: r.parent_name,
          email: r.email,
          kids: r.kids,
          date: session.date,
          sessionLabel: session.group,
          oldStartTime: rOldStart,
          oldEndTime: rOldEnd,
          newStartTime: session.startTime,
          newEndTime: session.endTime,
          location: session.location,
          changeType,
          oldLocation: locationChanged ? rOldLocation : undefined,
        });
        totalEmailsSent++;
      } catch (err) {
        console.error("Change notification email failed for", r.email, err);
      }

      // SMS
      if (r.sms_consent) {
        const dateStr = formatDateWithDay(session.date);
        const locName = resolveLocationName(session.location);
        let smsBody: string;
        if (changeType === "both") {
          smsBody = `TIME & LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nNew time: ${session.startTime}-${session.endTime}\nNew location: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else if (changeType === "time") {
          smsBody = `TIME CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nNew time: ${session.startTime}-${session.endTime} (was ${rOldStart}-${rOldEnd})\nLocation: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else {
          smsBody = `LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nNew location: ${locName}\nTime: ${session.startTime}-${session.endTime}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        }
        try {
          await sendSMS(r.phone, smsBody);
          totalSmsSent++;
        } catch (err) {
          console.error("Change notification SMS failed for", r.phone, err);
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
