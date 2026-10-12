import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import {
  resolveRegistrationPayment,
  computeBulkWeeklySettlement,
  isLateAction,
} from "@/lib/booking-finalize";

// Read-only "what would cancelling this actually move" for the admin cancel
// box, so it can state the real dollar amounts before anything happens
// instead of describing the mechanism in the abstract.
//
// This touches NOTHING: computeBulkWeeklySettlement only reads (its sibling
// re-pricing is applied by the caller, not by the settlement itself), and the
// package lookup is a select. The browser can't work any of this out on its
// own — it's never sent the payment intent, and a package session's money
// isn't on the registration row at all.
//
// body: { id }
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json().catch(() => ({ id: "" }));
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: reg } = await supabase
    .from("registrations")
    .select("id, type, email, booked_date, booked_start_time, is_paid, stripe_payment_intent_id, applied_account_credit, session_price, full_session_price, is_free, used_referral_credit, created_at, admin_change_at, package_id, is_full_camp, total_participants, booked_group, booked_trainer, is_bulk_discounted, booking_batch_id")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Registration not found" }, { status: 404 });

  const resolvedPayment = await resolveRegistrationPayment(supabase, reg);
  const paidVia = resolvedPayment.source;
  const isLate = !!(
    reg.booked_date &&
    reg.booked_start_time &&
    isLateAction(reg.booked_date, reg.booked_start_time, reg.created_at, reg.admin_change_at)
  );

  // A multi-day camp booked as a full camp settles across every day sharing
  // its referral code, not from this one row — quoting this row's own numbers
  // would be wrong, so say "can't preview" rather than show a wrong figure.
  if (reg.type === "camp" && reg.is_full_camp) {
    return NextResponse.json({
      paidVia,
      isLate,
      previewUnavailable: true,
      appliedCreditReturned: 0,
      referralCreditReturned: false,
      onTimeAmount: 0,
      lateAmount: 0,
      lateFeeKept: 0,
      packageSessionValue: null,
      hasOriginalCard: false,
      paidViaBatch: false,
    });
  }

  // One session's worth of the package's own enrollment price (what was
  // stamped at purchase, not today's rate). The service fee isn't split per
  // session, so it's not part of this.
  let packageSessionValue: number | null = null;
  let packageCardOnFile = false;
  if (reg.package_id) {
    const { data: pkg } = await supabase
      .from("monthly_packages")
      .select("package_type, total_price, stripe_payment_intent_id")
      .eq("id", reg.package_id)
      .maybeSingle();
    const sessions = pkg?.package_type || 0;
    const total = pkg?.total_price ?? 0;
    packageSessionValue = sessions > 0 ? Math.round((total / sessions) * 100) / 100 : 0;
    packageCardOnFile = !!pkg?.stripe_payment_intent_id;
  }

  const onTime = await computeBulkWeeklySettlement(reg, false);
  const late = await computeBulkWeeklySettlement(reg, true);

  return NextResponse.json({
    paidVia,
    isLate,
    previewUnavailable: false,
    // Returned on any refund regardless of destination — it was always
    // account credit, so it goes back as account credit.
    appliedCreditReturned: reg.applied_account_credit || 0,
    referralCreditReturned: !!reg.used_referral_credit,
    // What the booking itself settles to, before the destination choice.
    onTimeAmount: paidVia === "package" ? (packageSessionValue ?? 0) : onTime.refundOrCreditAmount,
    // If the late fee is charged, the remainder always goes to account
    // credit (never back to a card) — same as the cancel route.
    lateAmount: paidVia === "package" ? 0 : late.refundOrCreditAmount,
    lateFeeKept: paidVia === "package" ? 0 : late.lateFeeKept,
    packageSessionValue,
    hasOriginalCard: !!resolvedPayment.paymentIntentId || packageCardOnFile,
    // The charge was found on the original booking, not on this row.
    paidViaBatch: resolvedPayment.viaBatch,
  });
}
