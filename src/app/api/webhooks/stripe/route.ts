import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { finalizePaidCheckoutSession, expireAbandonedCheckoutSession } from "@/lib/booking-finalize";
import { findConfirmedByPaymentIntent } from "@/lib/supabase";
import { sendAdminSMS } from "@/lib/sms";

// A refund/dispute created OUTSIDE the app (Stripe Dashboard, a chargeback)
// has no code path back to the booking it belongs to otherwise — the DB
// would silently keep thinking the client is still confirmed and owes
// nothing further, with zero signal anywhere that money actually moved.
// This only alerts the admin with enough context to act manually (cancel,
// free the slot, respond to a dispute) rather than auto-mutating state,
// since the right action varies by why the refund/dispute happened.
async function alertOnExternalMoneyEvent(label: string, paymentIntentId: string | Stripe.PaymentIntent | null, amountDollars: number): Promise<void> {
  const piId = typeof paymentIntentId === "string" ? paymentIntentId : paymentIntentId?.id;
  if (!piId) {
    await sendAdminSMS(`${label}: $${amountDollars.toFixed(2)}\nNo payment intent id on the event — check Stripe dashboard for details.`).catch(() => {});
    return;
  }
  const { registrations, package: pkg } = await findConfirmedByPaymentIntent(piId);
  const context = pkg
    ? `${pkg.parent_name} — ${pkg.package_type}-session package (${pkg.month_year})`
    : registrations.length > 0
      ? registrations.map((r) => `${r.parent_name} — ${r.session_details}`).join("; ")
      : "no matching confirmed booking found — may already be handled";
  await sendAdminSMS(`${label}: $${amountDollars.toFixed(2)}\n${context}\nPayment: ${piId}\nReview in Stripe and update the booking manually if needed.`).catch(() => {});
}

// Stripe needs the raw, unparsed request body to verify the signature —
// same requirement as Twilio's webhook (see src/app/api/twilio/incoming),
// so this mirrors that route's shape: verify first, then act.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature") || "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await req.text();

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return new NextResponse("Not configured", { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return new NextResponse("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await finalizePaidCheckoutSession(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "checkout.session.expired") {
      await expireAbandonedCheckoutSession(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      // Only a FULL refund is worth alerting on here — issueStripeRefund
      // (the app's own refund path) always refunds the whole remaining
      // balance for whatever it's refunding, so a full refund on a charge
      // this app didn't already know about is the signal something
      // happened outside it. A partial refund from the Dashboard is rarer
      // and more clearly a manual/deliberate admin action already in the
      // admin's own hands.
      if (charge.amount_refunded >= charge.amount) {
        await alertOnExternalMoneyEvent("REFUND ISSUED (Stripe Dashboard or dispute)", charge.payment_intent, charge.amount_refunded / 100);
      }
    } else if (event.type === "charge.dispute.created") {
      const dispute = event.data.object as Stripe.Dispute;
      await alertOnExternalMoneyEvent("CHARGEBACK/DISPUTE — respond in Stripe before the deadline", dispute.payment_intent, dispute.amount / 100);
    }
  } catch (err) {
    console.error(`Stripe webhook handler error (${event.type}):`, err);
    // Return non-2xx so Stripe actually retries (it redelivers a failed
    // webhook for up to 3 days) — every handler here is safe to retry:
    // finalizePaidBookingBatch/abandonPendingBookingBatch only ever touch
    // rows still pending_payment, so a retry after a real failure tries
    // again for real, and a retry after something that actually already
    // succeeded is a harmless no-op.
    return new NextResponse("Internal error — please retry", { status: 500 });
  }

  return NextResponse.json({ received: true });
}
