import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationByToken,
  cancelRegistration,
  cancelFullCampByReferralCode,
  getEarliestCampDay,
  addRegistration,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
} from "@/lib/supabase";
import {
  sendCancellationNotification,
  sendRescheduleNotification,
} from "@/lib/email";
import {
  deletePrivateSessionFromCalendar,
  upsertGroupSessionCalendarEvent,
} from "@/lib/calendar";

// GET — fetch booking details
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: reg.id,
    parentName: reg.parent_name,
    email: reg.email,
    kids: reg.kids,
    type: reg.type,
    sessionDetails: reg.session_details,
    bookedDate: reg.booked_date,
    bookedStartTime: reg.booked_start_time,
    bookedEndTime: reg.booked_end_time,
    bookedLocation: reg.booked_location,
    status: reg.status,
    isFullCamp: reg.is_full_camp ?? false,
  });
}

// DELETE — cancel booking
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json(
      { error: "Booking is already cancelled" },
      { status: 400 }
    );
  }

  // Block camp cancellations once the camp has started.
  // For full camp, check the earliest day of the group so no day's token can be used
  // after the camp has already begun. For drop-in, check that specific day.
  if (reg.type === "camp") {
    const checkDay = reg.is_full_camp && reg.referral_code
      ? await getEarliestCampDay(reg.referral_code)
      : { booked_date: reg.booked_date!, booked_start_time: reg.booked_start_time! };

    if (checkDay?.booked_date && checkDay?.booked_start_time) {
      const timeMatch = checkDay.booked_start_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const period = timeMatch[3].toUpperCase();
        if (period === "PM" && hours !== 12) hours += 12;
        if (period === "AM" && hours === 12) hours = 0;
        const sessionDateTime = new Date(checkDay.booked_date);
        sessionDateTime.setHours(hours, mins, 0, 0);
        if (Date.now() >= sessionDateTime.getTime()) {
          return NextResponse.json(
            { error: "Cancellations are not accepted once the camp has started. The full amount is due." },
            { status: 400 }
          );
        }
      }
    }
  }

  // Check 24-hour policy
  let isLateCancel = false;
  if (reg.booked_date && reg.booked_start_time) {
    // Parse "March 20, 2026" + "3:00 PM" into a reliable Date
    const dateStr = reg.booked_date!;
    const timeStr = reg.booked_start_time!;
    const timeMatch = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      const sessionDateTime = new Date(`${dateStr}`);
      sessionDateTime.setHours(hours, mins, 0, 0);
      const hoursUntil =
        (sessionDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
      isLateCancel = hoursUntil >= 0 && hoursUntil < 48;
    }
  }

  // Full camp: block individual-day cancellation — must cancel all days together
  if (reg.type === "camp" && reg.is_full_camp) {
    if (!reg.referral_code) {
      return NextResponse.json({ error: "Cannot cancel — missing camp group reference." }, { status: 500 });
    }
    const success = await cancelFullCampByReferralCode(reg.referral_code);
    if (!success) {
      return NextResponse.json({ error: "Failed to cancel camp" }, { status: 500 });
    }
    const lateFeeAmount = reg.session_price && isLateCancel ? Math.round(reg.session_price * 0.5) : undefined;
    // Extract camp name (everything before the first " — " in session_details)
    const campName = reg.session_details.split(" — ")[0] || reg.session_details;
    await sendCancellationNotification({
      parentName: reg.parent_name,
      email: reg.email,
      sessionDetails: campName,
      sessionType: reg.type,
      isLateCancel,
      lateFeeAmount,
    });
    // Update calendar for this camp day (count decreases after cancellation)
    if (reg.booked_date && reg.booked_start_time) {
      try {
        await upsertGroupSessionCalendarEvent({
          sessionType: "camp",
          sessionLabel: campName,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids,
          participantsJustRegistered: reg.total_participants || 1,
        });
      } catch (err) {
        console.error("Calendar sync error (camp cancel):", err);
      }
    }
    return NextResponse.json({ success: true, isLateCancel });
  }

  const success = await cancelRegistration(token);
  if (!success) {
    return NextResponse.json(
      { error: "Failed to cancel" },
      { status: 500 }
    );
  }

  // Recalculate package sessions_used after cancellation
  if (reg.booked_date && (reg.type === "private" || reg.type === "group-private")) {
    try {
      const raw = reg.booked_date;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(raw + "T12:00:00")
        : new Date(raw);
      if (!isNaN(d.getTime())) {
        const bookingMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const activePkg = await getActivePackage(reg.email, bookingMonth);
        if (activePkg) {
          const confirmedCount = await countConfirmedPrivateSessions(reg.email, bookingMonth);
          const newUsed = Math.min(activePkg.package_type, confirmedCount);
          if (newUsed !== activePkg.sessions_used) {
            await setPackageSessions(activePkg.id, newUsed);
          }
        }
      }
    } catch {
      // non-critical — don't fail the cancellation
    }
  }

  const lateFeeAmount = reg.session_price && isLateCancel ? Math.round(reg.session_price * 0.5) : undefined;

  await sendCancellationNotification({
    parentName: reg.parent_name,
    email: reg.email,
    sessionDetails: reg.session_details,
    sessionType: reg.type,
    isLateCancel,
    lateFeeAmount,
  });

  // Sync calendar after cancellation
  if (reg.booked_date && reg.booked_start_time) {
    const isPrivate = reg.type === "private" || reg.type === "group-private";
    try {
      if (isPrivate) {
        await deletePrivateSessionFromCalendar({
          email: reg.email,
          bookedDate: reg.booked_date,
        });
      } else {
        // Group/weekly: update the event count (DB already reflects cancellation)
        const sessionLabel = reg.session_details.split(" — ")[0] || "Group Session";
        await upsertGroupSessionCalendarEvent({
          sessionType: reg.type as "weekly" | "camp",
          sessionLabel,
          bookedDate: reg.booked_date,
          bookedStartTime: reg.booked_start_time,
          bookedEndTime: reg.booked_end_time || reg.booked_start_time,
          bookedLocation: reg.booked_location || "",
          kidsJustRegistered: reg.kids,
          participantsJustRegistered: reg.total_participants || 1,
        });
      }
    } catch (err) {
      console.error("Calendar sync error (cancel):", err);
    }
  }

  return NextResponse.json({ success: true, isLateCancel });
}

// PUT — reschedule booking
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (reg.status !== "confirmed") {
    return NextResponse.json(
      { error: "Booking is already cancelled" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { bookedDate, bookedStartTime, bookedEndTime, bookedLocation } = body;

  if (!bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
    return NextResponse.json(
      { error: "Missing new session details" },
      { status: 400 }
    );
  }

  // Cancel old booking
  await cancelRegistration(token);

  // Create new booking
  const newSessionDetails = `Private Session — ${bookedDate} ${bookedStartTime}-${bookedEndTime} at ${bookedLocation}`;
  const { manageToken: newToken } = await addRegistration({
    parentName: reg.parent_name,
    email: reg.email,
    phone: reg.phone,
    kids: reg.kids,
    type: reg.type,
    sessionDetails: newSessionDetails,
    totalParticipants: reg.total_participants,
    bookedDate,
    bookedStartTime,
    bookedEndTime,
    bookedLocation,
  });

  await sendRescheduleNotification({
    parentName: reg.parent_name,
    email: reg.email,
    oldSessionDetails: reg.session_details,
    newSessionDetails,
    manageToken: newToken,
  });

  return NextResponse.json({ success: true, newToken });
}
