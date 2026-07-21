import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getRegistrationsByEmail,
  getReferralCredits,
  generateReferralCode,
  getProfileReferralCode,
  getActivePackage,
  getAccountCreditBalance,
  packageHasAnyBookedSession,
} from "@/lib/supabase";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";

// This returns every past/future booking's manage_token (the sole secret
// needed to cancel/reschedule it), plus kids' names, session prices,
// account credit balance, and referral credits — it must never trust a
// client-supplied email. Only the caller's OWN authenticated session can
// resolve which email to look up, same pattern as /api/profile.
async function getAuthedEmail(req: NextRequest): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email ? user.email.toLowerCase().trim() : null;
}

export async function POST(req: NextRequest) {
  const email = await getAuthedEmail(req);
  if (!email) {
    return NextResponse.json(
      { error: "Please log in to view your bookings." },
      { status: 401 }
    );
  }

  try {
    const currentMonthYear = new Date().toISOString().substring(0, 7); // "2026-03"
    const [registrations, referralCredits, activePackage, profileCode, weeklySessions, privateSlots, accountCreditBalance] = await Promise.all([
      getRegistrationsByEmail(email),
      getReferralCredits(email).catch(() => 0),
      getActivePackage(email, currentMonthYear).catch(() => null),
      getProfileReferralCode(email).catch(() => null),
      getWeeklySchedule().catch(() => []),
      getPrivateSlots().catch(() => []),
      getAccountCreditBalance(email).catch(() => 0),
    ]);

    // Build a location lookup keyed by "date|startTime" from the current sheet
    const locationLookup = new Map<string, string>();
    for (const s of weeklySessions) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }
    for (const s of privateSlots) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }

    const packageCancellable = activePackage ? !(await packageHasAnyBookedSession(activePackage.id).catch(() => true)) : false;

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
          bookedTrainer: r.booked_trainer,
          status: r.status,
          manageToken: r.manage_token,
        };
      }),
      rewards: {
        referralCredits,
        referralCode,
      },
      accountCredit: accountCreditBalance || 0,
      activePackage: activePackage
        ? {
            id: activePackage.id,
            packageType: activePackage.package_type,
            sessionsUsed: activePackage.sessions_used,
            monthYear: activePackage.month_year,
            cancellable: packageCancellable,
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
