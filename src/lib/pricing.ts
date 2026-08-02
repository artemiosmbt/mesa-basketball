// Fee added on top of every real Stripe charge (new bookings and reschedule
// topups) — covers Stripe's own processing cost. Applies uniformly
// regardless of card type/payment method, which keeps it outside NY's
// credit-card-surcharge rules (those only restrict fees charged for
// choosing credit over some other payment method — Stripe is the only way
// to pay here, so there's no "other method" being surcharged against).
// Never applied when nothing is actually being charged (e.g. a booking
// fully covered by a discount or account credit).
//
// Flat $4.50 undercharges on larger transactions (Stripe's own cut is
// percentage-based), so above the threshold the fee switches to a flat
// percentage instead. The threshold is chosen so the switch is roughly
// continuous — 3.2% of $140 is ~$4.48, just under the flat $4.50 — rather
// than jumping sharply at the boundary.
const SERVICE_FEE_FLAT = 4.5;
const SERVICE_FEE_THRESHOLD = 140;
const SERVICE_FEE_PERCENT = 0.032;
// Shared display string so the percentage shown in copy (registration form,
// Stripe checkout, etc.) can never drift from the actual rate above.
export const SERVICE_FEE_PERCENT_TEXT = `${(SERVICE_FEE_PERCENT * 100).toFixed(1)}%`;

// `chargeAmount` must be the actual pre-fee amount being charged to the
// card for THIS transaction (i.e. after any account credit/discount is
// subtracted) — not the full pre-credit order subtotal.
export function calcServiceFee(chargeAmount: number): number {
  if (chargeAmount <= SERVICE_FEE_THRESHOLD) return SERVICE_FEE_FLAT;
  return Math.round(chargeAmount * SERVICE_FEE_PERCENT * 100) / 100;
}

export function serviceFeeLabel(chargeAmount: number): string {
  return `$${calcServiceFee(chargeAmount).toFixed(2)}`;
}

// True when this charge falls in the percentage tier rather than the flat
// $4.50 tier — used to decide whether to show "(3.2%)" next to the "Service
// Fee" label, so customers can see why a larger charge's fee is bigger.
export function isPercentServiceFee(chargeAmount: number): boolean {
  return chargeAmount > SERVICE_FEE_THRESHOLD;
}

// "Service Fee" item name shown on the registration form, Stripe Checkout's
// own line items, and Stripe's receipt — appends "(3.2%)" only when this
// specific charge is actually in the percentage tier, never for the flat fee.
export function serviceFeeItemName(chargeAmount: number): string {
  return isPercentServiceFee(chargeAmount) ? `Service Fee (${SERVICE_FEE_PERCENT_TEXT})` : "Service Fee";
}

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

// Standard private-session hourly rate (1-3 kids). Single source of truth —
// this bare number used to be hardcoded independently in 12+ files (booking
// forms, admin dashboards, cancel/reschedule/no-show/add-player routes,
// confirmation emails); any future rate change only needs to touch this one
// constant instead of relying on every one of those spots being updated too.
export const PRIVATE_RATE = 150;
// Group-private (4+ kids) hourly rate.
export const GROUP_PRIVATE_RATE = 250;
// Rough flat fallback used ONLY when a legacy weekly/camp row has no stored
// session_price to fall back on — not a real distinct price, just a guess
// that avoids treating a missing/unset price as $0 (which would understate
// what's actually owed).
export const LEGACY_GROUP_SESSION_FALLBACK = 50;

// Prorated private-session price for a given duration and kid count.
export function calcPrivatePrice(durationMins: number, kidCount: number): number {
  const rate = kidCount >= 4 ? GROUP_PRIVATE_RATE : PRIVATE_RATE;
  return Math.round(rate * (durationMins / 60) * 100) / 100;
}

// Full session price fallback by type — used only when session_price is
// null (a real, common case for legacy rows) rather than treating an unset
// price as $0, which would understate what's actually owed.
export function fullPriceForType(type: string): number {
  if (type === "group-private") return GROUP_PRIVATE_RATE;
  if (type === "private") return PRIVATE_RATE;
  return LEGACY_GROUP_SESSION_FALLBACK;
}
