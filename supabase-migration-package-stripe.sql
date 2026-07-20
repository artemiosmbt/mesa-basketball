-- Stripe payment tracking on monthly_packages. Packages previously enrolled
-- immediately (status 'active') and expected payment via the old manual
-- cash/Venmo/Zelle flow. Now a package is inserted with status
-- 'pending_payment' before the client is redirected to Stripe Checkout, then
-- flipped to 'active' by the webhook once payment succeeds (or
-- 'payment_abandoned' if the checkout session expires unused) — same
-- convention as registrations. No CHECK constraint on status today, so
-- these are just new conventional values.

ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE INDEX IF NOT EXISTS idx_monthly_packages_stripe_checkout_session_id ON monthly_packages (stripe_checkout_session_id);
