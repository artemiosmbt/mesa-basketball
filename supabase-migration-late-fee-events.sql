-- A short-lived audit log of every late cancellation/reschedule fee actually
-- applied (client- or admin-initiated) — replaces the old manual
-- is_late_cancel/cancel_fee_settled "did I collect this" checklist, which
-- only made sense back when money moved by hand. Now that Stripe/account
-- credit moves the money automatically at the moment of the cancel/
-- reschedule, there's nothing left to "settle" — this is just a record of
-- what happened, kept around for a week (see the admin payments page,
-- which only ever queries the last 7 days) purely so recent activity is
-- visible without becoming permanent clutter. Nothing else in the app reads
-- this table, so old rows are safe to prune whenever convenient.
CREATE TABLE IF NOT EXISTS late_fee_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  registration_id uuid,
  parent_name text NOT NULL,
  email text,
  kids text,
  session_type text,
  session_details text,
  booked_date text,
  booked_start_time text,
  action text NOT NULL, -- 'cancel' | 'reschedule'
  initiated_by text NOT NULL, -- 'client' | 'admin'
  amount_kept numeric(10, 2) DEFAULT 0,        -- fee kept, not refunded
  amount_refunded numeric(10, 2) DEFAULT 0,    -- real Stripe refund issued
  amount_credited numeric(10, 2) DEFAULT 0,    -- account credit issued
  amount_applied numeric(10, 2) DEFAULT 0,     -- credit applied toward the new session (reschedule)
  amount_charged_extra numeric(10, 2) DEFAULT 0, -- additional amount charged (reschedule remainder)
  new_session_details text -- reschedule only: what it became
);

CREATE INDEX IF NOT EXISTS late_fee_events_created_at_idx ON late_fee_events (created_at);

-- Matches every other table in this project: all access goes through Next.js
-- API routes using the service role key, which bypasses RLS.
ALTER TABLE late_fee_events ENABLE ROW LEVEL SECURITY;
