import { NextRequest, NextResponse } from "next/server";
import { getPackageById, packageHasAnyBookedSession, cancelPackage, addAccountCredit } from "@/lib/supabase";
import { issueStripeRefund } from "@/lib/booking-finalize";
import { sendSMS, sendAdminSMS } from "@/lib/sms";
import { fmtMoney, packagePrice } from "@/lib/pricing";

// Client-initiated package cancellation — only ever allowed before a single
// session has been booked against it. Once any session exists (even a
// cancelled one — see packageHasAnyBookedSession), the package is
// considered "used" and can no longer be refunded this way; from that point
// on it just runs its course for the month.
export async function POST(req: NextRequest) {
  try {
    const { packageId, email } = await req.json();
    if (!packageId || !email) {
      return NextResponse.json({ error: "Missing packageId or email" }, { status: 400 });
    }

    const pkg = await getPackageById(packageId);
    if (!pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }
    if (pkg.email.toLowerCase().trim() !== String(email).toLowerCase().trim()) {
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

    // The $4.50 service fee is never refunded, on any cancellation — it
    // covers Stripe's own (also non-refundable) processing cut, so giving
    // it back would mean paying that cut out of pocket. Only the package
    // price itself is refunded/credited here.
    const totalPrice = packagePrice(pkg.package_type);

    let refundResult: { refundedAmount: number; creditedAmount: number; failed: boolean } | undefined;
    let creditIssued = 0;
    if (pkg.stripe_payment_intent_id) {
      refundResult = await issueStripeRefund({
        email: pkg.email,
        paymentIntentId: pkg.stripe_payment_intent_id,
        amountDollars: totalPrice,
        sessionLabel: `${pkg.package_type}-session package (${pkg.month_year})`,
      });
    } else {
      // Legacy package enrolled before Stripe existed for packages — no
      // card on file to refund, so it becomes account credit instead, same
      // fallback every other money-movement path in this app already uses.
      await addAccountCredit(pkg.email, totalPrice).catch(() => {});
      creditIssued = totalPrice;
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
      if (pkg.phone) {
        const message = refundFailed
          ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${pkg.month_year} has been cancelled. Your refund is being processed — you'll receive a separate confirmation once it's complete.`
          : refundedToCard > 0 && totalCredited > 0
            ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${pkg.month_year} has been cancelled. $${fmtMoney(refundedToCard)} has been refunded to your original payment method and $${fmtMoney(totalCredited)} credited to your account (the $4.50 service fee isn't refundable).`
            : totalCredited > 0
              ? `Mesa Basketball: Your ${pkg.package_type}-session package for ${pkg.month_year} has been cancelled. $${fmtMoney(totalCredited)} has been credited to your account (the $4.50 service fee isn't refundable).`
              : `Mesa Basketball: Your ${pkg.package_type}-session package for ${pkg.month_year} has been cancelled. $${fmtMoney(refundedToCard)} has been refunded to your original payment method (the $4.50 service fee isn't refundable).`;
        await sendSMS(pkg.phone, message);
      }
      const adminMoney = refundFailed
        ? "REFUND FAILED — needs manual action"
        : [refundedToCard > 0 ? `$${fmtMoney(refundedToCard)} refunded` : "", totalCredited > 0 ? `$${fmtMoney(totalCredited)} credited` : ""].filter(Boolean).join(", ") || "$0 due";
      await sendAdminSMS(`PACKAGE CANCELLED (never used): ${pkg.parent_name}\n${pkg.package_type}-session package — ${pkg.month_year}\n${adminMoney}`);
    } catch (err) {
      console.error("Package cancellation notification error:", err);
    }

    return NextResponse.json({ success: true, refundedAmount: refundedToCard, creditedAmount: totalCredited, refundFailed });
  } catch (error) {
    console.error("Package cancellation error:", error);
    return NextResponse.json({ error: "Cancellation failed. Please try again." }, { status: 500 });
  }
}
