-- Fixes a real over-refund bug: cancelling camp days one at a time
-- recomputed the "correct total right now" and diffed it against the
-- ORIGINAL full-camp price every single time, re-refunding ground already
-- covered by earlier day cancellations in the same camp group. This column
-- records how much was actually refunded/credited at the moment EACH day is
-- cancelled, so a later cancellation in the same group can net that out and
-- only refund the true incremental difference from there forward.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS camp_day_refund_issued INTEGER DEFAULT 0;
