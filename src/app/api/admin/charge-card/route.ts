import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAdmin } from "@/lib/auth";
import {
  resolveOffSessionPaymentSource,
  resolveOffSessionPaymentSourceByEmail,
  chargeSavedCardOffSession,
} from "@/lib/booking-finalize";
import { logRegistrationTopupCharge } from "@/lib/supabase";
import { calcServiceFee, fmtMoney } from "@/lib/pricing";
import { sendAdminSMS, sendSMS } from "@/lib/sms";

// Charging a card with the client not present — for collecting money the site
// itself didn't collect: a balance left over from a change made by hand, a
// session that went out unpaid, a difference someone owes. The admin is
// watching, so a failure is reported back rather than retried in the dark.
//
// Deliberately capped: a typo that turns $79.50 into $7950 on someone's card
// is far worse than having to run two charges.
const MAX_CHARGE = 1000;

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, amountDollars, addServiceFee = true, note, markPaid = true } = await req.json();
  const amount = Math.round(Number(amountDollars) * 100) / 100;
  if (!id) return NextResponse.json({ error: "Missing booking id" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Enter an amount greater than zero." }, { status: 400 });
  }
  if (amount > MAX_CHARGE) {
    return NextResponse.json({ error: `That's over the $${MAX_CHARGE} limit for a single charge — run it in smaller amounts if it's really that large.` }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: reg } = await supabase
    .from("registrations")
    .select("id, email, parent_name, phone, sms_consent, kids, session_details, status, is_paid, stripe_customer_id, stripe_payment_intent_id, package_id")
    .eq("id", id)
    .single();

  if (!reg) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (!reg.email) return NextResponse.json({ error: "This booking has no email on it, so there's no customer to charge." }, { status: 400 });

  // Prefer the card this booking itself was paid with; fall back to whatever
  // is on file for their email (a credit-paid booking has no Stripe identity
  // of its own — which is exactly the case this button exists for).
  const source =
    (await resolveOffSessionPaymentSource(reg)) ||
    (await resolveOffSessionPaymentSourceByEmail(reg.email));

  if (!source) {
    return NextResponse.json(
      { error: "No saved card on file for this client. Send them a Stripe payment link instead." },
      { status: 400 }
    );
  }

  const fee = addServiceFee ? calcServiceFee(amount) : 0;
  const total = Math.round((amount + fee) * 100) / 100;
  const label = (reg.session_details || "Mesa Basketball Training").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
  const description = note ? `${note} — ${label}` : `Balance due — ${label}`;

  const charge = await chargeSavedCardOffSession({
    customerId: source.customerId,
    paymentMethodId: source.paymentMethodId,
    amountDollars: total,
    description,
  });

  if (!charge.success || !charge.paymentIntentId) {
    return NextResponse.json({ error: charge.reason || "The charge didn't go through." }, { status: 400 });
  }

  // Recorded as its own charge so revenue and payroll reporting can see money
  // that arrived outside the normal checkout — same table the add-player and
  // reschedule top-ups use.
  await logRegistrationTopupCharge({
    registrationId: reg.id,
    stripePaymentIntentId: charge.paymentIntentId,
    priceDelta: amount,
    serviceFee: fee,
    source: "admin_charge",
  });

  // A booking with no Stripe payment of its own now has one. Worth attaching:
  // it's what a later cancellation refunds against. Never overwritten when the
  // booking already has its own payment — that one is the session's real
  // charge, and replacing it would point refunds at the wrong money.
  const patch: Record<string, unknown> = {};
  if (!reg.stripe_payment_intent_id) patch.stripe_payment_intent_id = charge.paymentIntentId;
  if (!reg.stripe_customer_id) patch.stripe_customer_id = source.customerId;
  if (markPaid && !reg.is_paid) patch.is_paid = true;
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("registrations").update(patch).eq("id", reg.id);
    if (error) {
      console.error("charge-card: charge succeeded but the booking couldn't be updated:", error);
      await sendAdminSMS(
        `⚠️ Charged $${fmtMoney(total)} to ${reg.parent_name || reg.email}'s card, but the booking record couldn't be updated. Mark it paid manually. (${charge.paymentIntentId})`
      ).catch(() => {});
    }
  }

  // Tell the client what just came out of their card. Stripe emails its own
  // receipt, but a line in plain English from Mesa is what stops a "what is
  // this charge?" text at 9pm.
  if (reg.sms_consent && reg.phone) {
    await sendSMS(
      reg.phone,
      `Mesa Basketball: $${fmtMoney(total)} charged to your card on file${note ? ` — ${note}` : ""}.\n${label}\nQuestions? Just reply.\nReply STOP to opt out.`
    ).catch(() => {});
  }
  await sendAdminSMS(
    `CHARGED: ${reg.parent_name || reg.email}\n$${fmtMoney(total)}${fee > 0 ? ` ($${fmtMoney(amount)} + $${fmtMoney(fee)} service fee)` : ""}\n${label}${note ? `\nNote: ${note}` : ""}`
  ).catch(() => {});

  return NextResponse.json({
    ok: true,
    chargedAmount: total,
    baseAmount: amount,
    serviceFee: fee,
    paymentIntentId: charge.paymentIntentId,
  });
}
