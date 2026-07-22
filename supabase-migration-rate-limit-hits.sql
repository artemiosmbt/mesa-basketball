-- Lightweight rate limiter for public unauthenticated endpoints
-- (/api/register, /api/waitlist) that otherwise have zero abuse protection
-- — no Redis/Vercel KV exists in this stack, so this piggybacks on Supabase
-- like every other cheap check in this codebase. Each row is one "hit" for
-- one key (an IP, email, or phone, prefixed by which limiter it belongs to,
-- e.g. "register:ip:1.2.3.4"). Counting rows within a recent window IS the
-- rate limit — no separate counter column to keep in sync.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_key text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key_created
  ON rate_limit_hits (rate_key, created_at);
ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;
