import { NextRequest, NextResponse } from "next/server";
import { getRegistrationByToken } from "@/lib/supabase";
import { computePlayerEditPricing } from "@/lib/booking-finalize";
import { calcServiceFee } from "@/lib/pricing";

// Read-only preview of what a player-list change would cost — computed with
// the exact same function the real PATCH handler uses to actually charge
// it (computePlayerEditPricing), so this can never quote a different number
// than what Stripe ends up charging a moment later. Nothing here mutates
// the booking or creates a Stripe session.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const reg = await getRegistrationByToken(token);
  if (!reg) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (reg.status !== "confirmed") return NextResponse.json({ error: "Booking is not active" }, { status: 400 });
  if (reg.type === "camp") return NextResponse.json({ error: "Player edits are not available for camp bookings" }, { status: 400 });

  const body = await req.json();
  const { players } = body as { players: string[] };
  if (!Array.isArray(players) || players.filter((p) => p.trim()).length === 0) {
    return NextResponse.json({ error: "At least one player is required" }, { status: 400 });
  }

  const pricing = await computePlayerEditPricing(reg, players);
  const paymentRequired = pricing.wasPaid && pricing.totalOwedViaCheckout > 0;
  const serviceFee = paymentRequired ? calcServiceFee(pricing.totalOwedViaCheckout) : 0;

  return NextResponse.json({
    paymentRequired,
    addedPlayers: pricing.addedPlayers,
    removedPlayers: pricing.removedPlayers,
    oldAmount: pricing.oldAmount,
    newAmount: pricing.newAmount,
    priceDelta: pricing.priceDelta,
    isLate: pricing.isLate,
    lateFeeDue: pricing.lateFeeDue,
    // What Stripe would actually charge, split out for display — the
    // session-cost portion and the separately-disclosed service fee.
    amountOwed: pricing.totalOwedViaCheckout,
    serviceFee,
    totalCharge: Math.round((pricing.totalOwedViaCheckout + serviceFee) * 100) / 100,
    // A price decrease with nothing else owed grants account credit instead
    // of charging anything — surfaced so the client can show that instead
    // of a payment prompt.
    creditGranted: pricing.wasPaid && pricing.priceDelta < 0 && pricing.totalOwedViaCheckout === 0
      ? Math.round(-pricing.priceDelta * 100) / 100
      : 0,
  });
}
