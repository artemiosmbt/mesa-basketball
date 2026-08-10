-- Closes a whitespace-matching gap found while live-testing the admin
-- dashboard's trainer-scoping filters: .ilike("booked_trainer", ...) alone
-- handles a casing difference correctly (ilike IS case-insensitive by
-- definition), but does NOT collapse or trim whitespace — a schedule-sheet
-- name typed as "Artemios  Gavalas" (double space) or with leading/
-- trailing space would silently fail to ilike-match "Artemios Gavalas",
-- same as any two-source string comparison problem already fixed
-- elsewhere in this codebase (trainerNamesMatch/
-- normalizeTrainerNameForComparison in src/lib/trainers.ts already do this
-- correctly for other trainer-name comparisons). Pre-existing pattern, not
-- introduced by the lazy-loading redesign — but that redesign multiplied
-- the number of places doing a bare .ilike() from 1 to 8+, so worth
-- closing everywhere at once now that there's a single shared place to do
-- it (src/lib/admin-data-scope.ts).
--
-- Mirrors normalizeTrainerNameForComparison exactly: trim, lowercase,
-- collapse internal whitespace runs to one space.
CREATE OR REPLACE FUNCTION normalize_trainer_name(text) RETURNS text AS $$
  SELECT lower(trim(regexp_replace($1, '\s+', ' ', 'g')))
$$ LANGUAGE sql IMMUTABLE;

-- Extends the existing view (supabase-migration-admin-dashboard-upcoming-view.sql)
-- rather than creating a second one, so every admin-dashboard query already
-- using it for date-range filtering gets trainer-name filtering "for free"
-- from the same FROM clause.
CREATE OR REPLACE VIEW registrations_with_parsed_date AS
SELECT *,
  parse_booked_date(booked_date) AS booked_date_parsed,
  normalize_trainer_name(booked_trainer) AS booked_trainer_normalized
FROM registrations;

CREATE INDEX IF NOT EXISTS idx_registrations_booked_trainer_normalized
  ON registrations (normalize_trainer_name(booked_trainer));
