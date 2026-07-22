-- Tracks which week's SMS reminder blast has already run. week_start is the
-- primary key, so a second overlapping cron invocation for the SAME week
-- (retry, manual re-trigger) fails to claim it and skips sending entirely,
-- instead of texting every opted-in client twice.
CREATE TABLE IF NOT EXISTS sms_reminder_runs (
  week_start text PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  texts_sent integer DEFAULT 0
);
ALTER TABLE sms_reminder_runs ENABLE ROW LEVEL SECURITY;
