-- Tracks athlete names a parent has explicitly removed from their saved
-- roster (via Settings' full-roster save) so the ambient booking-sync paths
-- (syncAthleteGroupsFromBooking, /api/profile/athletes) never silently
-- recreate one just because a later booking happens to type that name
-- again — see the removed_kid_names comment in /api/profile/route.ts.
-- Idempotent — safe to re-run.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS removed_kid_names text[] NOT NULL DEFAULT '{}';
