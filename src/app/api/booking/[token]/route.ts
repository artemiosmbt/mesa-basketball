import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationByToken,
  cancelRegistration,
  addRegistration,
} from "@/lib/supabase";
import {
  sendCancellationNotification,
  sendRescheduleNotification,
} from "@/lib/email";

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

  // Check 24-hour policy
  let isLateCancel = false;
  if (reg.booked_date && reg.booked_start_time) {
    const sessionDateTime = new Date(
      `${reg.booked_date} ${reg.booked_start_time}`
    );
    const hoursUntil =
      (sessionDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
    isLateCancel = hoursUntil < 24;
  }

  const success = await cancelRegistration(token);
  if (!success) {
    return NextResponse.json(
      { error: "Failed to cancel" },
      { status: 500 }
    );
  }

  await sendCancellationNotification({
    parentName: reg.parent_name,
    email: reg.email,
    sessionDetails: reg.session_details,
    isLateCancel,
  });

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
