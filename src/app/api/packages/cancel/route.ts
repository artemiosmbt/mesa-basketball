import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPackageById, packageHasAnyBookedSession, cancelPackage, revertPackageCancellation, addAccountCredit } from "@/lib/supabase";
import { issueStripeRefund } from "@/lib/booking-finalize";
import { sendSMS, sendAdminSMS, formatMonthYear } from "@/lib/sms";
import { fmtMoney, packagePrice, calcServiceFee, type TrainerTier } from "@/lib/pricing";
import { sendPackageCancellationNotification } from "@/lib/email";

// The ownership check below must never trust a client-supplied email —
// only the caller's OWN authenticated session can prove which package is
// theirs to cancel (same pattern as /api/my-bookings).
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

// Client-initiated package cancellation — only ever allowed before a single
// session has been booked against it. Once any session exists (even a
// cancelled one — see packageHasAnyBookedSession), the package is
// considered "used" and can no longer be refunded this way; from that point
// on it just runs its course for the month.
export async function POST(req: NextRequest) {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      return NextResponse.json({ error: "Please log in to cancel your package." }, { status: 401 });
    }
    const { packageId } = await req.json();
    if (!packageId) {
      return NextResponse.json({ error: "Missing packageId" }, { status: 400 });
    }

    const pkg = await getPackageById(packageId);
    if (!pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }
    if (pkg.email.toLowerCase().trim() !== email) {
      return NextResponse.json({ error: "This package doesn't belong to that email" }, { status: 403 });
    }
    if (pkg.status !== "active") {
      return NextResponse.json({ error: "This package is no longer active" }, { status: 400 });
    }

    const alreadyUsed = await packageHasAnyBookedSession(packageId);
    if (alreadyUsed) {
      return NextResponse.json({ error: "This package can't be cancelled anymore — a session has already been booked against it." }, { status: 400 });
    }

    const cancelled = await cancelPackage(packageId);
    if (!cancelled) {
      // Zero rows matched — another request already cancelled this (double
      // click, retry). Bail out before the refund below runs twice.
      return NextResponse.json({ error: "This package was already cancelled" }, { status: 409 });
    }

    // Re-check after the flip — the check above and the cancel itself are
    // two separate queries with no shared transaction, so a register request
    // that read "no session yet" and inserted one in the gap between them
    // would otherwise slip through, giving a full refund for a package that
    // now has a real booked (and possibly serviced) session against it.
    const usedAfterAll = await packageHasAnyBookedSession(packageId);
    if (usedAfterAll) {
      await revertPackageCancellation(packageId);
      return NextResponse.json({ error: "This package can't be cancelled anymore — a session has already been booked against it." }, { status: 400 });
    }

    // The service fee is never refunded, on any cancellation — it covers
    // Stripe's own (also non-refundable) processing cut, so giving it back
    // would mean paying that cut out of pocket. Only the package price
    // itself is refunded/credited here. Always refund what was ACTUALLY
    // CHARGED at enrollment (total_price), not packagePrice()'s current
    // return value — if the rate changes between enrollment and
    // cancellation, recomputing live would refund the wrong amount. The
    // packagePrice() fallback only covers packages enrolled before this
    // column existed (already backfilled by migration, but defensive here too).
    const totalPrice = pkg.total_price ?? packagePrice(pkg.package_type, (pkg.trainer_tier as TrainerTier) || "artemios");
    // Any account credit applied at enrollment was never a card charge —
    // only the remainder actually hit Stripe, so only that remainder is
    // ever refundable there.
    const appliedCredit = pkg.applied_account_credit || 0;
    const cardChargedAmount = Math.max(0, totalPrice - appliedCredit);
    // The fee itself was computed on the post-credit charge at enrollment
    // (see /api/packages), not the full package price — match that here so
    // this message names the fee actually paid. A fully credit-covered
    // enrollment never went through Stripe at all, so no fee was ever
    // charged — nothing to mention as non-refundable in that case.
    const serviceFeeText = fmtMoney(calcServiceFee(cardChargedAmount));
    const feeClause = cardChargedAmount > 0 ? ` (the $${serviceFeeText} service fee isn't refundable)` : "";
    const monthLabel = formatMonthYear(pkg.month_year);

    let refundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
    let creditIssued = 0;
    if (pkg.stripe_payment_intent_id && cardChargedAmount > 0) {
      refundResult = await issueStripeRefund({
        email: pkg.email,
        paymentIntentId: pkg.stripe_payment_intent_id,
        amountDollars: cardChargedAmount,
        sessionLabel: `${pkg.package_type}-session package (${monthLabel})`,
      });
    } else if (!pkg.stripe_payment_intent_id && cardChargedAmount > 0) {
      // Legacy package enrolled before Stripe existed for packages — no
      // card on file to refund, so it becomes account credit instead, same
      // fallback every other money-movement path in this app already uses.
      await addAccountCredit(pkg.email, cardChargedAmount).catch(() => {});
      creditIssued = cardChargedAmount;
    }
    // Whatever was paid with account credit at enrollment goes straight
    // back to that balance — it was never a card charge to begin with.
    if (appliedCredit > 0) {
      await addAccountCredit(pkg.email, appliedCredit).catch(() => {});
      creditIssued += appliedCredit;
    }

    const refundFailed = !!refundResult?.failed;
    // issueStripeRefund's amount_too_large fallback can split this into a
    // PARTIAL card refund plus account credit for the shortfall (rare — only
    // if something already ate into this payment intent's refundable
    // balance out-of-band) — creditIssued alone only ever covers the
    // no-card-on-file path, so it silently missed that split entirely and
    // told the client their FULL amount was refunded to the card when only
    // part of it actually was.
    const refundedToCard = refundResult?.refundedAmount ?? 0;
    const totalCredited = creditIssued + (refundResult?.creditedAmount ?? 0);
    try {
      await sendPackageCancellationNotification({
        parentName: pkg.parent_name,
        email: pkg.email,
        packageType: pkg.package_type,
        monthYear: pkg.month_year,
        refundOutcome: { refundedAmount: refundedToCard, creditedAmount: totalCredited, failed: refundFailed },
      });
    } catch (err) {
      console.error("Package cancellation email failed (cancellation still succeeded):", err);
    }
    try {
      if (pkg.sms_consent && pkg.phone) {
        const message = refundFailed
          ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${monthLabel} has been cancelled. Your refund is being processed — you'll receive a separate confirmation once it's complete.`
          : refundedToCard > 0 && totalCredited > 0
            ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${monthLabel} has been cancelled. $${fmtMoney(refundedToCard)} has been refunded to your original payment method and $${fmtMoney(totalCredited)} credited to your account.${feeClause}`
            : totalCredited > 0
              ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${monthLabel} has been cancelled. $${fmtMoney(totalCredited)} has been credited to your account.${feeClause}`
              : `Mesa Basketball: Your ${pkg.package_type}-session package for ${monthLabel} has been cancelled. $${fmtMoney(refundedToCard)} has been refunded to your original payment method.${feeClause}`;
        await sendSMS(pkg.phone, message);
      }
      const adminMoney = refundFailed
        ? "REFUND FAILED — needs manual action"
        : [refundedToCard > 0 ? `$${fmtMoney(refundedToCard)} refunded` : "", totalCredited > 0 ? `$${fmtMoney(totalCredited)} credited` : ""].filter(Boolean).join(", ") || "$0 due";
      await sendAdminSMS(`PACKAGE CANCELLED (never used): ${pkg.parent_name}\n${pkg.package_type}-session package — ${monthLabel}\n${adminMoney}`);
    } catch (err) {
      console.error("Package cancellation notification error:", err);
    }

    return NextResponse.json({
      success: true,
      refundedAmount: refundedToCard,
      creditedAmount: totalCredited,
      refundFailed,
      // 0 whenever nothing was ever actually charged to a card (fully
      // credit-covered enrollment) — matches feeClause's logic above, so
      // the client's own confirmation message doesn't cite a fee that was
      // never charged.
      serviceFee: cardChargedAmount > 0 ? calcServiceFee(cardChargedAmount) : 0,
    });
  } catch (error) {
    console.error("Package cancellation error:", error);
    return NextResponse.json({ error: "Cancellation failed. Please try again." }, { status: 500 });
  }
}
