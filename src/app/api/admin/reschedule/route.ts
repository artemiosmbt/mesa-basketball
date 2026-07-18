import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "@/lib/auth";
import {
  addPrivateSessionToCalendar,
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";
import { sendRescheduleNotification } from "@/lib/email";
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

// Admin-initiated move of a single confirmed booking to a new day/time/location.
// Unlike the client-facing reschedule, this updates the row in place (same
// manage_token, same id) and never charges a late fee — the business made the
// change, not the client.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, bookedDate, bookedStartTime, bookedEndTime, bookedLocation } = await req.json();
  if (!id || !bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: reg } = await supabase
    .from("registrations")
    .select("*")
    .eq("id", id)
    .single();

  if (!reg) {
    return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json({ error: "Only confirmed bookings can be rescheduled" }, { status: 400 });
  }

  const oldSessionDetails: string = reg.session_details;
  const oldBookedDate: string | null = reg.booked_date;
  const oldBookedStartTime: string | null = reg.booked_start_time;

  // Rebuild session_details by swapping only the trailing "date time at location"
  // segment. The group/camp label prefix is preserved verbatim — it may itself
  // contain " — " (e.g. "High School Girls — Grades 9-12"), so we must not
  // naively split on that separator and reconstruct from the first piece.
  const parts = (oldSessionDetails || "").split(" — ");
  const prefix = parts.length > 1 ? parts.slice(0, -1).join(" — ") : (parts[0] || "");
  const newSessionDetails = `${prefix} — ${bookedDate} ${bookedStartTime}-${bookedEndTime} at ${bookedLocation}`;

  const { error } = await supabase
    .from("registrations")
    .update({
      booked_date: bookedDate,
      booked_start_time: bookedStartTime,
      booked_end_time: bookedEndTime,
      booked_location: bookedLocation,
      session_details: newSessionDetails,
      admin_change_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync calendar. Private sessions are a single event tied to the booking;
  // group/camp sessions are shared events keyed by date+time+label, so we
  // recompute the old slot (this registrant leaving) and the new slot (this
  // registrant arriving) from what's now in the DB.
  const isPrivate = reg.type === "private" || reg.type === "group-private";
  try {
    if (isPrivate) {
      if (oldBookedDate) {
        await deletePrivateSessionFromCalendar({ email: reg.email, bookedDate: oldBookedDate });
      }
      await addPrivateSessionToCalendar({
        parentName: reg.parent_name,
        email: reg.email,
        phone: reg.phone,
        kids: reg.kids,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        trainer: reg.booked_trainer || undefined,
      });
    } else {
      const sessionLabel = reg.booked_group || prefix;
      if (oldBookedDate && oldBookedStartTime) {
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: oldBookedDate,
          bookedStartTime: oldBookedStartTime,
          bookedEndTime: reg.booked_end_time || oldBookedStartTime,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: "",
          participantsJustRegistered: 0,
        });
      }
      await upsertGroupSessionCalendarEvent({
        sessionType: reg.type as "weekly" | "camp",
        sessionLabel,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        kidsJustRegistered: reg.kids,
        participantsJustRegistered: reg.total_participants || 1,
      });
    }
  } catch (err) {
    console.error("Calendar sync error (admin reschedule):", err);
  }

  // Notify the client — no late fee, this was the business's call.
  try {
    await sendRescheduleNotification({
      parentName: reg.parent_name,
      email: reg.email,
      oldSessionDetails,
      newSessionDetails,
      manageToken: reg.manage_token,
      isLateReschedule: false,
      newTrainer: reg.booked_trainer || undefined,
    });
    if (reg.sms_consent && reg.phone) {
      await sendSMS(
        reg.phone,
        `Mesa Basketball: Your session has been rescheduled by your trainer.\n${formatDateWithDay(bookedDate)} | ${bookedStartTime}-${bookedEndTime}\nLocation: ${resolveLocationName(bookedLocation)}\nAthlete: ${reg.kids}\nManage: mesabasketballtraining.com/booking/${reg.manage_token}\nReply STOP to opt out.`
      );
    }
    await sendAdminSMS(`ADMIN RESCHEDULED: ${reg.parent_name}\nFrom: ${oldSessionDetails}\nTo: ${newSessionDetails}\nPlayers: ${reg.kids}`);
  } catch (err) {
    console.error("Notification error (admin reschedule):", err);
  }

  return NextResponse.json({ success: true, sessionDetails: newSessionDetails });
}
