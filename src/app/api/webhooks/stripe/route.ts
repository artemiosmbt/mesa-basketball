import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { finalizePaidCheckoutSession, expireAbandonedBookingBatch } from "@/lib/booking-finalize";

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
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
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

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const bookingBatchId = session.client_reference_id;
  if (!bookingBatchId) return;
  await expireAbandonedBookingBatch(bookingBatchId);
}
