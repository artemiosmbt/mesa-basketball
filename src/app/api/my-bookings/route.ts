import { NextRequest, NextResponse } from "next/server";
import {
  getRegistrationsByEmail,
  getReferralCredits,
  generateReferralCode,
  getProfileReferralCode,
  getActivePackage,
} from "@/lib/supabase";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";

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
    const [registrations, referralCredits, activePackage, profileCode, weeklySessions, privateSlots] = await Promise.all([
      getRegistrationsByEmail(email),
      getReferralCredits(email).catch(() => 0),
      getActivePackage(email, currentMonthYear).catch(() => null),
      getProfileReferralCode(email).catch(() => null),
      getWeeklySchedule().catch(() => []),
      getPrivateSlots().catch(() => []),
    ]);

    // Build a location lookup keyed by "date|startTime" from the current sheet
    const locationLookup = new Map<string, string>();
    for (const s of weeklySessions) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }
    for (const s of privateSlots) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }

    // Profile is source of truth; fall back to registrations, then generate from name
    const referralCode =
      profileCode ||
      registrations.find((r) => r.referral_code)?.referral_code ||
      generateReferralCode(
        registrations.length > 0 ? registrations[0].parent_name : email.split("@")[0]
      );

    return NextResponse.json({
      registrations: registrations.map((r) => {
        let sessionDetails = r.session_details;
        let bookedLocation = r.booked_location;

        // If the sheet now has a different location for this session, use it
        if (r.booked_date && r.booked_start_time) {
          const sheetLocation = locationLookup.get(`${r.booked_date}|${r.booked_start_time}`);
          if (sheetLocation && sheetLocation !== r.booked_location) {
            bookedLocation = sheetLocation;
            if (r.booked_location && sessionDetails) {
              sessionDetails = sessionDetails.replaceAll(r.booked_location, sheetLocation);
            }
          }
        }

        return {
          id: r.id,
          createdAt: r.created_at,
          parentName: r.parent_name,
          kids: r.kids,
          type: r.type,
          sessionDetails,
          bookedDate: r.booked_date,
          bookedStartTime: r.booked_start_time,
          bookedEndTime: r.booked_end_time,
          bookedLocation,
          status: r.status,
          manageToken: r.manage_token,
        };
      }),
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
