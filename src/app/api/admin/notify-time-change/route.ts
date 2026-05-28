import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import { getRegistrantsBySession } from "@/lib/supabase";
import { sendTimeChangeNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS, formatDateWithDay } from "@/lib/sms";

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

// GET — preview who will be notified (no notifications sent)
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const startTime = searchParams.get("startTime");

  if (!date || !startTime) {
    return NextResponse.json({ error: "Missing date or startTime" }, { status: 400 });
  }

  const registrants = await getRegistrantsBySession(date, startTime);
  return NextResponse.json({
    registrants: registrants.map((r) => ({
      id: r.id,
      parent_name: r.parent_name,
      email: r.email,
      phone: r.phone,
      kids: r.kids,
      sms_consent: r.sms_consent,
      booked_end_time: r.booked_end_time,
      booked_location: r.booked_location,
    })),
  });
}

// POST — send notifications and update DB records
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { date, oldStartTime, newStartTime, newEndTime, sessionLabel } = body as {
    date: string;
    oldStartTime: string;
    newStartTime: string;
    newEndTime: string;
    sessionLabel: string;
  };

  if (!date || !oldStartTime || !newStartTime || !newEndTime) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const registrants = await getRegistrantsBySession(date, oldStartTime);

  if (registrants.length === 0) {
    return NextResponse.json({ success: true, notified: 0, emailsSent: 0, smsSent: 0 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let emailsSent = 0;
  let smsSent = 0;

  for (const r of registrants) {
    const oldEndTime = r.booked_end_time || oldStartTime;
    const label = sessionLabel || "Group Session";

    // Update DB: fix the stored time and session_details string
    const newDetails = (r.session_details || "")
      .replace(`${oldStartTime}-${oldEndTime}`, `${newStartTime}-${newEndTime}`)
      .replace(`${oldStartTime}–${oldEndTime}`, `${newStartTime}–${newEndTime}`);

    await supabase
      .from("registrations")
      .update({
        booked_start_time: newStartTime,
        booked_end_time: newEndTime,
        session_details: newDetails,
      })
      .eq("id", r.id);

    // Send email
    try {
      await sendTimeChangeNotification({
        parentName: r.parent_name,
        email: r.email,
        kids: r.kids,
        date,
        sessionLabel: label,
        oldStartTime,
        oldEndTime,
        newStartTime,
        newEndTime,
        location: r.booked_location || "",
      });
      emailsSent++;
    } catch (err) {
      console.error("Time change email failed for", r.email, err);
    }

    // Send SMS if consented
    if (r.sms_consent) {
      const dateStr = formatDateWithDay(date);
      const smsBody = `Mesa Basketball: ${dateStr} session time update. ${label}: now ${newStartTime}-${newEndTime} (was ${oldStartTime}-${oldEndTime}). Same location. Questions? (631) 599-1280. Reply STOP to opt out.`;
      try {
        await sendSMS(r.phone, smsBody);
        smsSent++;
      } catch (err) {
        console.error("Time change SMS failed for", r.phone, err);
      }
    }
  }

  // Admin summary
  const dateStr = formatDateWithDay(date);
  await sendAdminSMS(
    `TIME CHANGE SENT: ${dateStr} — ${sessionLabel || "Group Session"}\n${oldStartTime} → ${newStartTime}-${newEndTime}\n${emailsSent} email${emailsSent !== 1 ? "s" : ""}, ${smsSent} SMS sent to ${registrants.length} registrant${registrants.length !== 1 ? "s" : ""}`
  );

  return NextResponse.json({ success: true, notified: registrants.length, emailsSent, smsSent });
}
