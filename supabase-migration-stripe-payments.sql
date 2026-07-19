-- Stripe payment tracking on registrations. A booking is inserted with
-- status 'pending_payment' before the client is redirected to Stripe
-- Checkout, then flipped to 'confirmed' by the webhook once payment
-- succeeds (or 'payment_abandoned' if the checkout session expires
-- unused). No CHECK constraint on status today (see register/route.ts and
-- booking/[token]/route.ts, which already write 'confirmed'/'cancelled'/
-- 'no_show' as plain strings), so these are just new conventional values.

-- Shared by every registrations row created together in one checkout
-- attempt (a multi-session weekly booking, a multi-day camp, or a batch of
-- recurring private sessions) — lets the webhook find and finalize the
-- whole batch from Stripe's client_reference_id in one query.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS booking_batch_id text;

-- The Checkout Session that collected payment for this row's batch.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;

-- The underlying PaymentIntent once payment succeeds — refunds (full on a
-- 24+-hour cancellation, partial on a reschedule price decrease) are made
-- against this.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

-- Stripe Customer object for this client, so future bookings/top-up
-- checkouts can be linked to the same customer in the Stripe dashboard.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- Audit trail for the most recent refund issued against this booking.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_refund_id text;

CREATE INDEX IF NOT EXISTS idx_registrations_booking_batch_id ON registrations (booking_batch_id);
CREATE INDEX IF NOT EXISTS idx_registrations_stripe_checkout_session_id ON registrations (stripe_checkout_session_id);
