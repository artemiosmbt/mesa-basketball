-- Claim-before-send lock for the twice-daily group-session reminder email
-- cron, mirroring sms_reminder_runs: run_key is the primary key, so a second
-- overlapping invocation for the same window (retry, manual re-trigger)
-- fails to claim it and skips sending entirely, instead of double-emailing
-- every opted-in parent.
CREATE TABLE IF NOT EXISTS reminder_email_runs (
  run_key TEXT PRIMARY KEY, -- e.g. "2026-08-07-morning" / "2026-08-06-evening"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  emails_sent INTEGER DEFAULT 0
);
ALTER TABLE reminder_email_runs ENABLE ROW LEVEL SECURITY;
