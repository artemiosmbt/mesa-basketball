import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Stripe not configured");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

/** One-off "amount off" coupon that represents account credit applied to a
 *  Checkout Session — shared by every booking type (registrations, packages)
 *  so the credit shows as its own line on Stripe's own page rather than
 *  silently shrinking the session price line. */
export async function buildCreditDiscount(stripe: Stripe, creditApplied: number): Promise<{ coupon: string }[] | undefined> {
  if (creditApplied <= 0) return undefined;
  const coupon = await stripe.coupons.create({
    amount_off: Math.round(creditApplied * 100),
    currency: "usd",
    duration: "once",
    name: "Account Credit",
  });
  return [{ coupon: coupon.id }];
}
