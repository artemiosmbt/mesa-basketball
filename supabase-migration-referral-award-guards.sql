-- Two guards against a client already able to slip past app-level checks
-- under a race or a redelivered webhook:
--
-- 1. referral_credit_awards: one lifetime credit per (referrer, referred)
--    pair. Every referral-bonus call site now inserts a row here before
--    calling addReferralCredit — a unique-violation means this pair was
--    already awarded (double-submit, retried request, or a rare concurrent
--    race on the same brand-new client), so the second attempt is skipped.
CREATE TABLE IF NOT EXISTS referral_credit_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_email text NOT NULL,
  referred_email text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (referrer_email, referred_email)
);
ALTER TABLE referral_credit_awards ENABLE ROW LEVEL SECURITY;

-- 2. profiles.referral_code should never collide between two people — a
-- collision would silently route a referral credit to the wrong family.
-- Partial (NULLS not distinct isn't available pre-PG15, so a plain unique
-- index on a nullable column already treats multiple NULLs as fine) unique
-- index so two concurrently-created profiles can never land on the same code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_referral_code_unique
  ON profiles (referral_code)
  WHERE referral_code IS NOT NULL;
