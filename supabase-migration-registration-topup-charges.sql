-- Records every real off-session Stripe charge that tops up an EXISTING
-- registration after its original checkout (admin "Add Player", or a late
-- reschedule's charged remainder — see chargeSavedCardOffSession in
-- booking-finalize.ts). These are genuinely separate, additional Stripe
-- charges with their own service fee, but until this table existed nothing
-- persisted them anywhere: add-player/route.ts and admin/reschedule/route.ts
-- only ever held the new charge's payment_intent_id transiently (for a
-- possible refund-on-failure), so no revenue report could ever know a
-- second charge happened. This is the real fix for the Bryan Schrubbe case
-- (booked once, topped up once, charged twice — but only one charge was
-- ever visible in reporting).
--
-- Unlike late_fee_events (an intentionally short-lived ~1-week audit log,
-- safe to prune), this table is permanent — monthly-revenue-sync.ts and
-- payroll-sync.ts both read it for all-time revenue/payroll reporting.
CREATE TABLE IF NOT EXISTS registration_topup_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  registration_id uuid NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  price_delta numeric(10, 2) NOT NULL, -- the pre-fee amount actually owed
  service_fee numeric(10, 2) NOT NULL, -- calcServiceFee(price_delta), captured at charge time
  source text NOT NULL -- 'add_player' | 'reschedule_topup'
);

CREATE INDEX IF NOT EXISTS registration_topup_charges_registration_id_idx ON registration_topup_charges (registration_id);

-- Matches every other table in this project: all access goes through Next.js
-- API routes using the service role key, which bypasses RLS.
ALTER TABLE registration_topup_charges ENABLE ROW LEVEL SECURITY;
