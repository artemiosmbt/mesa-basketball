import { NextRequest, NextResponse } from "next/server";
import { getStalePendingBatches, getStalePendingPackages } from "@/lib/supabase";
import { expireAbandonedBookingBatch, expireAbandonedCheckoutSession, expireAbandonedPackage, finalizePaidCheckoutSession } from "@/lib/booking-finalize";
import { getStripe } from "@/lib/stripe";

// Safety net for missed checkout.session.expired (or checkout.session.completed)
// webhook deliveries — Stripe Checkout Sessions are created with a 30-minute
// expiry, so anything still pending_payment after 2 hours means either the
// webhook never landed, or it landed and failed. Before assuming "never
// paid," this asks Stripe directly whether the session actually completed —
// a missed/delayed completed-payment webhook must self-heal here rather than
// getting permanently marked payment_abandoned while the customer was
// actually charged.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const batches = await getStalePendingBatches(STALE_AFTER_MS);
  let healed = 0;
  let expired = 0;
  let skipped = 0;

  for (const batch of batches) {
    try {
      if (batch.checkoutSessionId) {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(batch.checkoutSessionId);
        if (session.payment_status === "paid" || session.status === "complete") {
          // The webhook was missed or failed, but the customer WAS actually
          // charged — self-heal through the exact same finalize path the
          // webhook would have used, instead of abandoning a paid booking.
          await finalizePaidCheckoutSession(session);
          healed++;
          continue;
        }
        if (session.status === "open") {
          // Still genuinely in progress somehow (shouldn't happen given the
          // 30-minute expiry, but don't abandon a live checkout on a fluke).
          skipped++;
          continue;
        }
        // Route through the session-aware expiry, not just the batch id —
        // an on-time reschedule's price-increase topup checkout carries
        // metadata identifying the client's original (already-cancelled)
        // charge, which needs a real refund on abandonment. Falling back to
        // the plain batch-id path below would silently skip that refund
        // whenever the webhook missed this expiry and the cron catches it.
        await expireAbandonedCheckoutSession(session);
        expired++;
        continue;
      }
      await expireAbandonedBookingBatch(batch.bookingBatchId);
      expired++;
    } catch (err) {
      // Don't guess "abandoned" on a Stripe API error (rate limit, network
      // blip) — leave it pending_payment and let the next hourly run retry.
      console.error(`Failed to process stale booking batch ${batch.bookingBatchId}:`, err);
      skipped++;
    }
  }

  // Same self-heal-or-expire sweep, for monthly package purchases — a
  // separate table/id scheme from registrations, so it's its own loop.
  const packages = await getStalePendingPackages(STALE_AFTER_MS);
  for (const pkg of packages) {
    try {
      if (pkg.checkoutSessionId) {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(pkg.checkoutSessionId);
        if (session.payment_status === "paid" || session.status === "complete") {
          await finalizePaidCheckoutSession(session);
          healed++;
          continue;
        }
        if (session.status === "open") {
          skipped++;
          continue;
        }
      }
      await expireAbandonedPackage(pkg.packageId);
      expired++;
    } catch (err) {
      console.error(`Failed to process stale package ${pkg.packageId}:`, err);
      skipped++;
    }
  }

  return NextResponse.json({ checked: batches.length + packages.length, healed, expired, skipped });
}
