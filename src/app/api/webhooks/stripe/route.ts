import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { finalizePaidBookingBatch } from "@/lib/supabase";
import { finalizeConfirmedPrivateBooking, expireAbandonedBookingBatch } from "@/lib/booking-finalize";

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
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
    }
  } catch (err) {
    console.error(`Stripe webhook handler error (${event.type}):`, err);
    // Still ack with 200 below — Stripe retries on non-2xx, and re-running a
    // failed finalize is exactly what we want (finalizePaidBookingBatch's
    // pending-only WHERE clause makes it safe to retry).
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const bookingBatchId = session.client_reference_id;
  if (!bookingBatchId) {
    console.error("checkout.session.completed with no client_reference_id", session.id);
    return;
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id || null;
  if (!paymentIntentId) {
    console.error("checkout.session.completed with no payment_intent", session.id);
    return;
  }

  // Only rows still pending_payment get flipped here — a duplicate webhook
  // delivery for the same session finds nothing left to update and this
  // returns an empty array, so the notification/calendar side effects below
  // never run twice.
  const confirmedRows = await finalizePaidBookingBatch(bookingBatchId, paymentIntentId, customerId);
  if (confirmedRows.length === 0) return;

  const metadata = session.metadata || {};
  const isFirstTime = metadata.is_first_time === "true";
  const privateReferrer = metadata.referrer_email
    ? { email: metadata.referrer_email, name: metadata.referrer_name || "" }
    : null;

  for (const reg of confirmedRows) {
    if (reg.type !== "private" && reg.type !== "group-private") continue; // Phase 1 scope
    if (!reg.booked_date || !reg.booked_start_time) continue;
    await finalizeConfirmedPrivateBooking({
      parentName: reg.parent_name,
      email: reg.email,
      phone: reg.phone,
      kids: reg.kids,
      type: reg.type,
      sessionDetails: reg.session_details,
      totalParticipants: reg.total_participants,
      bookedDate: reg.booked_date,
      bookedStartTime: reg.booked_start_time,
      bookedEndTime: reg.booked_end_time || reg.booked_start_time,
      bookedLocation: reg.booked_location || "",
      bookedTrainer: reg.booked_trainer || undefined,
      manageToken: reg.manage_token,
      isFree: reg.is_free,
      isFirstTime,
      referralCode: reg.referral_code || "",
      privateReferrer,
      submittedReferralCode: metadata.submitted_referral_code || undefined,
      smsConsent: !!reg.sms_consent,
      accountCreditApplied: reg.applied_account_credit || 0,
      fullPrice: reg.session_price ?? undefined,
    });
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const bookingBatchId = session.client_reference_id;
  if (!bookingBatchId) return;
  await expireAbandonedBookingBatch(bookingBatchId);
}
