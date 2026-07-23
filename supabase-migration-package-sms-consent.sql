-- Add SMS consent column to monthly_packages table.
-- SMS consent for a package purchase previously only ever existed
-- transiently in Stripe Checkout metadata (read once by the webhook for the
-- one-time purchase-confirmation SMS, then gone) — there was no way for a
-- LATER, separate request (e.g. package cancellation) to know the client's
-- actual consent choice. This persists it on the package row itself.
ALTER TABLE monthly_packages
ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT false;
