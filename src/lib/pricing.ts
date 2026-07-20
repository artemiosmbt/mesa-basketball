// Flat fee added on top of every real Stripe charge (new bookings and
// reschedule topups) — covers Stripe's own processing cost. Applies
// uniformly regardless of card type/payment method, which keeps it outside
// NY's credit-card-surcharge rules (those only restrict fees charged for
// choosing credit over some other payment method — Stripe is the only way
// to pay here, so there's no "other method" being surcharged against).
// Never applied when nothing is actually being charged (e.g. a booking
// fully covered by a discount or account credit).
export const SERVICE_FEE = 4.5;
export const SERVICE_FEE_LABEL = `$${SERVICE_FEE.toFixed(2)}`;

// Always renders a dollar amount with two decimal places (e.g. 154.5 ->
// "154.50") — used anywhere a price appears in client-facing copy so it
// never looks truncated/wrong next to genuinely-even amounts like "$150".
export function fmtMoney(n: number): string {
  return n.toFixed(2);
}

// Monthly private-session package price. Single source of truth — this used
// to be the same `packageType === 4 ? 475 : 900` ternary hardcoded
// separately in three different files (purchase, cancellation, and
// confirmation-email logic); any future price change only needed to touch
// one of them and the others would silently keep charging/refunding the old
// amount.
export function packagePrice(packageType: number): number {
  return packageType === 4 ? 475 : 900;
}
