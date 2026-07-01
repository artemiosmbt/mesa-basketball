-- Adds a group/session label column so capacity and enrollment counts for
-- group sessions and camps are scoped per-session, not just per date+time.
-- Without this, two different groups (or camps) running at the same time
-- shared one combined capacity pool instead of each getting its own 8 spots.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS booked_group TEXT;

-- Backfill existing weekly/camp rows: session_details always starts with
-- "<Group Name> — ..." (or "<Camp Name> — ..."), so the group name is the
-- text before the first " — ". Needed so already-booked sessions keep their
-- correct enrollment count instead of dropping to 0 under the new key.
UPDATE registrations
SET booked_group = split_part(session_details, ' — ', 1)
WHERE type IN ('weekly', 'camp')
  AND booked_group IS NULL
  AND session_details IS NOT NULL;
