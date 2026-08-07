-- Backfills a stable UUID `id` and an empty `groups` array onto every
-- athlete already saved in profiles.kids that's missing them. Needed so
-- add/edit/delete-one-athlete and group-assignment API calls can target a
-- specific kid instead of relying on array position (which shifts as kids
-- are added/removed). Idempotent — an athlete that already has both fields
-- is left untouched, so this is safe to re-run.
UPDATE profiles
SET kids = (
  SELECT COALESCE(jsonb_agg(
    (CASE WHEN elem ? 'id' THEN elem ELSE elem || jsonb_build_object('id', gen_random_uuid()::text) END)
    || CASE WHEN elem ? 'groups' THEN '{}'::jsonb ELSE jsonb_build_object('groups', '[]'::jsonb) END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(kids) AS elem
)
WHERE kids IS NOT NULL AND jsonb_typeof(kids) = 'array' AND jsonb_array_length(kids) > 0;
