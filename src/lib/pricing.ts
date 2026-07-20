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
