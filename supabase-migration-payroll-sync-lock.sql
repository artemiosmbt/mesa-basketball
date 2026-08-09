-- Single-row lock so two overlapping runPayrollSync() executions (a
-- serverless retry firing while the original invocation is still mid-flight,
-- or a manual re-trigger overlapping the scheduled cron) can't both compute
-- the same "next empty row" for a trainer tab and interleave two different
-- registrations' data into one row. Claimed via a conditional UPDATE
-- (`is_running = false` -> `true`) in runPayrollSync — Postgres's row-level
-- atomicity means only one concurrent caller's UPDATE actually matches and
-- succeeds; the loser sees zero rows affected and skips its run instead of
-- proceeding. Released in a `finally` so a mid-run error/timeout can't leave
-- the lock stuck forever.
CREATE TABLE IF NOT EXISTS payroll_sync_lock (
  id INTEGER PRIMARY KEY,
  is_running BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ
);

INSERT INTO payroll_sync_lock (id, is_running)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;
