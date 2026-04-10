-- Enable Row-Level Security on all public tables
-- All data access goes through Next.js API routes using the service role key,
-- which bypasses RLS — so this blocks anon key access without breaking anything.

ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE existing_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_packages ENABLE ROW LEVEL SECURITY;
