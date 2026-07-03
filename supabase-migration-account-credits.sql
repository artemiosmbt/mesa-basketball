-- Account credit ledger: money owed back to a family (e.g. from a partial
-- camp cancellation) becomes credit toward their next booking instead of a
-- cash refund. Single running balance per email, same pattern as
-- referral_credits, but a dollar amount rather than a session count.
CREATE TABLE IF NOT EXISTS account_credits (
  email text PRIMARY KEY,
  balance integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- Matches every other table in this project (see supabase-migration-enable-rls.sql):
-- all access goes through Next.js API routes using the service role key, which
-- bypasses RLS, so this blocks anon key access without breaking anything.
ALTER TABLE account_credits ENABLE ROW LEVEL SECURITY;

-- Tracks how much account credit was applied to a specific booking row, so
-- it can be refunded back to the balance if that booking is later cancelled.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS applied_account_credit INTEGER DEFAULT 0;
