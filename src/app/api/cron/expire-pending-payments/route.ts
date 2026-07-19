import { NextRequest, NextResponse } from "next/server";
import { getStalePendingBatchIds } from "@/lib/supabase";
import { expireAbandonedBookingBatch } from "@/lib/booking-finalize";

// Safety net for missed checkout.session.expired webhook deliveries —
// Stripe Checkout Sessions are created with a 30-minute expiry, so anything
// still pending_payment after 2 hours almost certainly means the webhook
// never landed. Same auth pattern as the other crons in vercel.json.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const batchIds = await getStalePendingBatchIds(STALE_AFTER_MS);
  let expired = 0;
  for (const batchId of batchIds) {
    try {
      await expireAbandonedBookingBatch(batchId);
      expired++;
    } catch (err) {
      console.error(`Failed to expire stale booking batch ${batchId}:`, err);
    }
  }

  return NextResponse.json({ checked: batchIds.length, expired });
}
