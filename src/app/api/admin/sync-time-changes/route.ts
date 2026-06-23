import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";
import { sendTimeChangeNotification, sendCancellationNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email === ADMIN_EMAIL;
}

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

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
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
    console.error("sync-time-changes: failed to fetch schedule", err);
    return NextResponse.json({ error: "Could not load schedule from Google Sheets." }, { status: 500 });
  }

  const upcoming = sessions.filter((s) => sessionIsUpcoming(s.date, s.startTime) && s.startTime && s.group);

  const changesFound: { session: string; oldTime: string; newTime: string; count: number }[] = [];
  let totalEmailsSent = 0;
  let totalSmsSent = 0;

  // === TIME / LOCATION CHANGE DETECTION ===
  for (const session of upcoming) {
    const { data: allRegs, error } = await supabase
      .from("registrations")
      .select("*")
      .eq("booked_date", session.date)
      .eq("type", "weekly")
      .eq("status", "confirmed")
      .ilike("session_details", `%${session.group}%`);

    if (error) continue;

    const stale = (allRegs || []).filter(
      (r) =>
        r.booked_start_time !== session.startTime ||
        r.booked_end_time !== session.endTime ||
        r.booked_location !== session.location
    );

    if (stale.length === 0) continue;

    const oldStartTime: string = stale[0].booked_start_time;
    const oldEndTime: string = stale[0].booked_end_time || oldStartTime;

    changesFound.push({
      session: `${session.date} — ${session.group}`,
      oldTime: `${oldStartTime}–${oldEndTime}`,
      newTime: `${session.startTime}–${session.endTime}`,
      count: stale.length,
    });

    for (const r of stale) {
      const timeChanged = r.booked_start_time !== session.startTime || r.booked_end_time !== session.endTime;
      const locationChanged = r.booked_location !== session.location;
      const changeType: "time" | "location" | "both" =
        timeChanged && locationChanged ? "both" : timeChanged ? "time" : "location";

      const rOldStart: string = r.booked_start_time;
      const rOldEnd: string = r.booked_end_time || rOldStart;
      const rOldLocation: string = r.booked_location || "";

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
          admin_change_at: new Date().toISOString(),
        })
        .eq("id", r.id);

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

      if (r.sms_consent) {
        const dateStr = formatDateWithDay(session.date);
        const locName = resolveLocationName(session.location);
        let smsBody: string;
        const oldLocName = resolveLocationName(rOldLocation);
        if (changeType === "both") {
          smsBody = `TIME & LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${oldLocName} → ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else if (changeType === "time") {
          smsBody = `TIME CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nTime: ${rOldStart}-${rOldEnd} → ${session.startTime}-${session.endTime}\nLocation: ${locName}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        } else {
          smsBody = `LOCATION CHANGE\nMesa Basketball: ${session.group} on ${dateStr}\nLocation: ${oldLocName} → ${locName}\nTime: ${session.startTime}-${session.endTime}\nQuestions? (631) 599-1280. Reply STOP to opt out.`;
        }
        try {
          await sendSMS(r.phone, smsBody);
          totalSmsSent++;
        } catch (err) {
          console.error("Change notification SMS failed for", r.phone, err);
        }
      }
    }
  }

  if (changesFound.length > 0) {
    const summary = changesFound
      .map((c) => `• ${c.session}: ${c.oldTime} → ${c.newTime} (${c.count} registrant${c.count !== 1 ? "s" : ""})`)
      .join("\n");
    await sendAdminSMS(
      `TIME CHANGES SYNCED:\n${summary}\n${totalEmailsSent} email${totalEmailsSent !== 1 ? "s" : ""}, ${totalSmsSent} SMS sent`
    );
  }

  // === DELETION DETECTION — WEEKLY SESSIONS ===
  // If a row is gone from the sheet but there are still confirmed bookings for it, cancel them.
  const sheetWeeklyKeys = new Set(upcoming.map((s) => `${s.date}|${s.group}`));

  const { data: allWeeklyRegs } = await supabase
    .from("registrations")
    .select("*")
    .eq("type", "weekly")
    .eq("status", "confirmed");

  const upcomingWeeklyRegs = (allWeeklyRegs || []).filter(
    (r) => r.booked_date && sessionIsUpcoming(r.booked_date, r.booked_start_time || "")
  );

  const weeklyBySession = new Map<string, typeof upcomingWeeklyRegs>();
  for (const r of upcomingWeeklyRegs) {
    const group = (r.session_details || "").split(" — ")[0].trim();
    const key = `${r.booked_date}|${group}`;
    if (!weeklyBySession.has(key)) weeklyBySession.set(key, []);
    weeklyBySession.get(key)!.push(r);
  }

  const deletedFound: { session: string; date: string; count: number }[] = [];
  let cancelEmailsSent = 0;
  let cancelSmsSent = 0;

  for (const [key, regs] of weeklyBySession) {
    if (sheetWeeklyKeys.has(key)) continue;

    const pipeIdx = key.indexOf("|");
    const date = key.slice(0, pipeIdx);
    const sessionLabel = key.slice(pipeIdx + 1);

    deletedFound.push({ session: sessionLabel, date, count: regs.length });

    for (const r of regs) {
      await supabase
        .from("registrations")
        .update({ status: "cancelled", is_late_cancel: false })
        .eq("id", r.id);

      try {
        await sendCancellationNotification({
          parentName: r.parent_name,
          email: r.email,
          sessionDetails: r.session_details || "",
          sessionType: r.type,
          isLateCancel: false,
        });
        cancelEmailsSent++;
      } catch (err) {
        console.error("Deletion cancel email failed for", r.email, err);
      }

      if (r.sms_consent && r.phone) {
        const dateStr = formatDateWithDay(r.booked_date);
        const locName = resolveLocationName(r.booked_location || "");
        const timeStr = `${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`;
        try {
          await sendSMS(
            r.phone,
            `CANCELLED\nMesa Basketball: ${sessionLabel} on ${dateStr}\nTime: ${timeStr}${locName ? `\nLocation: ${locName}` : ""}\nSession cancelled by trainer.\nQuestions? (631) 599-1280\nReply STOP to opt out.`
          );
          cancelSmsSent++;
        } catch (err) {
          console.error("Deletion cancel SMS failed for", r.phone, err);
        }
      }
    }
  }

  // === DELETION DETECTION — PRIVATE SESSIONS ===
  let privateSlots: Awaited<ReturnType<typeof getPrivateSlots>> = [];
  try {
    privateSlots = await getPrivateSlots({ noCache: true });
  } catch (err) {
    console.error("sync-time-changes: failed to fetch private slots", err);
  }

  const sheetPrivateKeys = new Set(privateSlots.map((s) => `${s.date}|${s.startTime}`));

  const { data: allPrivateRegs } = await supabase
    .from("registrations")
    .select("*")
    .in("type", ["private", "group-private"])
    .eq("status", "confirmed");

  const upcomingPrivateRegs = (allPrivateRegs || []).filter(
    (r) => r.booked_date && sessionIsUpcoming(r.booked_date, r.booked_start_time || "")
  );

  for (const r of upcomingPrivateRegs) {
    const key = `${r.booked_date}|${r.booked_start_time}`;
    if (sheetPrivateKeys.has(key)) continue;

    const sessionLabel = (r.session_details || "").split(" — ")[0].trim() || "Private Session";
    deletedFound.push({ session: sessionLabel, date: r.booked_date, count: 1 });

    await supabase
      .from("registrations")
      .update({ status: "cancelled", is_late_cancel: false })
      .eq("id", r.id);

    try {
      await sendCancellationNotification({
        parentName: r.parent_name,
        email: r.email,
        sessionDetails: r.session_details || "",
        sessionType: r.type,
        isLateCancel: false,
      });
      cancelEmailsSent++;
    } catch (err) {
      console.error("Deletion cancel email failed for", r.email, err);
    }

    if (r.sms_consent && r.phone) {
      const dateStr = formatDateWithDay(r.booked_date);
      const locName = resolveLocationName(r.booked_location || "");
      const timeStr = `${r.booked_start_time}${r.booked_end_time ? `-${r.booked_end_time}` : ""}`;
      try {
        await sendSMS(
          r.phone,
          `CANCELLED\nMesa Basketball: Private Session on ${dateStr}\nTime: ${timeStr}${locName ? `\nLocation: ${locName}` : ""}\nSession cancelled by trainer.\nQuestions? (631) 599-1280\nReply STOP to opt out.`
        );
        cancelSmsSent++;
      } catch (err) {
        console.error("Deletion cancel SMS failed for", r.phone, err);
      }
    }
  }

  if (deletedFound.length > 0) {
    const summary = deletedFound
      .map((d) => `• ${d.session} on ${d.date} (${d.count} booking${d.count !== 1 ? "s" : ""})`)
      .join("\n");
    try {
      await sendAdminSMS(
        `SESSIONS CANCELLED (deleted from sheet):\n${summary}\n${cancelEmailsSent} email${cancelEmailsSent !== 1 ? "s" : ""}, ${cancelSmsSent} SMS sent`
      );
    } catch (err) {
      console.error("Admin deletion summary SMS failed:", err);
    }
  }

  return NextResponse.json({
    success: true,
    changesFound,
    totalEmailsSent,
    totalSmsSent,
    deletedFound,
    cancelEmailsSent,
    cancelSmsSent,
  });
}
