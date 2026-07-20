-- Tracks which specific monthly_packages row (if any) covered a private/
-- group-private booking's price. Needed once package-covered sessions
-- charge $0 via Stripe — without this, there's no reliable way to tell "this
-- session was covered by a package" apart from "this session happened to be
-- free/covered by account credit for some other reason," which matters for
-- cancel/reschedule/no-show handling (a package session's late fee has to be
-- a fresh charge, since there's no per-session Stripe payment to draw a
-- credit/refund from).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS package_id uuid;
CREATE INDEX IF NOT EXISTS idx_registrations_package_id ON registrations (package_id);
