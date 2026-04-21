import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationsByEmail,
  getReferralCredits,
  generateReferralCode,
  getProfileReferralCode,
  getActivePackage,
} from "@/lib/supabase";

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
    const currentMonthYear = new Date().toISOString().substring(0, 7); // "2026-03"
    const [registrations, referralCredits, activePackage, profileCode] = await Promise.all([
      getRegistrationsByEmail(email),
      getReferralCredits(email).catch(() => 0),
      getActivePackage(email, currentMonthYear).catch(() => null),
      getProfileReferralCode(email).catch(() => null),
    ]);

    // Profile is source of truth; fall back to registrations, then generate from name
    const referralCode =
      profileCode ||
      registrations.find((r) => r.referral_code)?.referral_code ||
      generateReferralCode(
        registrations.length > 0 ? registrations[0].parent_name : email.split("@")[0]
      );

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
      rewards: {
        referralCredits,
        referralCode,
      },
      activePackage: activePackage
        ? {
            packageType: activePackage.package_type,
            sessionsUsed: activePackage.sessions_used,
            monthYear: activePackage.month_year,
          }
        : null,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to look up bookings" },
      { status: 500 }
    );
  }
}
