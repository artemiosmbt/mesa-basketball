import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getRegistrationsByEmail,
  getReferralCredits,
  getOrCreatePersistedReferralCode,
  getProfileReferralCode,
  getActivePackage,
  getAccountCreditBalance,
  packageHasAnyBookedSession,
  getLateFeeEventsForRegistrations,
} from "@/lib/supabase";
import { getWeeklySchedule, getPrivateSlots } from "@/lib/sheets";

// This returns every past/future booking's manage_token (the sole secret
// needed to cancel/reschedule it), plus kids' names, session prices,
// account credit balance, and referral credits — it must never trust a
// client-supplied email. Only the caller's OWN authenticated session can
// resolve which email to look up, same pattern as /api/profile.
async function getAuthedUser(req: NextRequest): Promise<{ id: string; email: string } | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.email ? { id: user.id, email: user.email.toLowerCase().trim() } : null;
}

export async function POST(req: NextRequest) {
  const authedUser = await getAuthedUser(req);
  if (!authedUser) {
    return NextResponse.json(
      { error: "Please log in to view your bookings." },
      { status: 401 }
    );
  }

  const email = authedUser.email;
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

    // A cancelled / moved / no-show session stays in the parent's history
    // with what happened to the money — the fee events for those rows.
    const num = (v: number | string | null | undefined) => (typeof v === "string" ? parseFloat(v) : v) || 0;
    const feeEvents = await getLateFeeEventsForRegistrations(
      registrations.filter((r) => r.status === "cancelled" || r.status === "no_show" || r.is_late_cancel).map((r) => r.id),
    ).catch(() => []);
    const feeByReg = new Map<string, typeof feeEvents>();
    for (const e of feeEvents) { const arr = feeByReg.get(e.registration_id) || []; arr.push(e); feeByReg.set(e.registration_id, arr); }

    // Build a location lookup keyed by "date|startTime" from the current sheet
    const locationLookup = new Map<string, string>();
    for (const s of weeklySessions) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }
    for (const s of privateSlots) {
      if (s.date && s.startTime) locationLookup.set(`${s.date}|${s.startTime}`, s.location);
    }

    const packageCancellable = activePackage ? !(await packageHasAnyBookedSession(activePackage.id).catch(() => true)) : false;

    // Profile is source of truth; fall back to registrations, then
    // generate+persist a real one — never the bare unchecked generator,
    // which could collide with another family sharing the same last name.
    const referralCode =
      profileCode ||
      registrations.find((r) => r.referral_code)?.referral_code ||
      (await getOrCreatePersistedReferralCode(
        authedUser.id,
        email,
        registrations.length > 0 ? registrations[0].parent_name : email.split("@")[0]
      ));

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
          cancellation: (r.status === "cancelled" || r.status === "no_show" || r.is_late_cancel)
            ? {
                late: !!r.is_late_cancel,
                packageSession: !!r.package_id,
                campDayFee: num(r.camp_day_late_fee),
                events: (feeByReg.get(r.id) || []).map((e) => ({
                  action: e.action,
                  by: e.initiated_by,
                  at: e.created_at,
                  kept: num(e.amount_kept),
                  refunded: num(e.amount_refunded),
                  credited: num(e.amount_credited),
                  applied: num(e.amount_applied),
                  chargedExtra: num(e.amount_charged_extra),
                  movedTo: e.new_session_details,
                })),
              }
            : null,
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
            // Actual price charged at enrollment — never recompute this
            // client-side from the live rate, which may have changed since
            // (and now also depends on which trainer tier was purchased).
            totalPrice: activePackage.total_price ?? null,
            trainerTier: activePackage.trainer_tier || "artemios",
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
