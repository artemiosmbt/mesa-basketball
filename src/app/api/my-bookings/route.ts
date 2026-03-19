import { NextRequest, NextResponse } from "next/server";
import { getRegistrationsByEmail } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { email } = body;

  if (!email || typeof email !== "string") {
    return NextResponse.json(
      { error: "Email is required" },
      { status: 400 }
    );
  }

  try {
    const registrations = await getRegistrationsByEmail(email);
    return NextResponse.json({
      registrations: registrations.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        parentName: r.parent_name,
        kids: r.kids,
        type: r.type,
        sessionDetails: r.session_details,
        bookedDate: r.booked_date,
        bookedStartTime: r.booked_start_time,
        bookedEndTime: r.booked_end_time,
        bookedLocation: r.booked_location,
        status: r.status,
        manageToken: r.manage_token,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to look up bookings" },
      { status: 500 }
    );
  }
}
