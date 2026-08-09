-- Speeds up the admin dashboard's lazy-loading redesign (Upcoming/Past
-- windowing, Calendar month-scoping, Clients aggregate, full-history
-- search bypass) without changing any behavior, and without touching any
-- application write path. Purely additive — safe to run anytime.
--
-- registrations.booked_date is stored as plain TEXT in whatever format the
-- schedule sheet exports ("August 9, 2026"), not a real date — so a raw
-- comparison like `booked_date >= '2026-07-10'` would sort/filter
-- alphabetically, not chronologically (e.g. "August..." would sort before
-- "March..." even though August is later in the year). Every date-range
-- query the lazy-loading redesign needs (Past's "last 30 days", Calendar's
-- "this month") instead reads it through TO_DATE(booked_date, 'FMMonth DD,
-- YYYY') — verified against every month name and both single/double-digit
-- days before relying on this. Application code (Phase 2+) MUST use this
-- exact same expression in its queries, or Postgres won't use the indexes
-- below at all.
CREATE INDEX IF NOT EXISTS idx_registrations_booked_date_parsed
  ON registrations ((TO_DATE(booked_date, 'FMMonth DD, YYYY')));

-- Composite for the single most common combined filter (status + date
-- window together) — lets Postgres use one index instead of intersecting
-- two.
CREATE INDEX IF NOT EXISTS idx_registrations_status_booked_date_parsed
  ON registrations (status, (TO_DATE(booked_date, 'FMMonth DD, YYYY')));

-- Plain (non-parsed) index too — several existing queries elsewhere in the
-- app (capacity checks, conflict checks) already do exact-text equality
-- lookups like .eq("booked_date", "August 9, 2026"), which this backs
-- directly; the parsed/functional index above doesn't help an exact-text
-- match.
CREATE INDEX IF NOT EXISTS idx_registrations_booked_date ON registrations (booked_date);

-- Status is in every windowed/search predicate (confirmed, pending_payment,
-- cancelled, payment_abandoned).
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations (status);

-- Client-detail (?email=) exact lookups and the Clients-tab aggregate
-- GROUP BY. lower() since email comparisons are always case-normalized
-- elsewhere in this codebase.
CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations (lower(email));

-- Backs the server-side package-membership sub-query (one client's private/
-- group-private sessions, filtered to a specific month).
CREATE INDEX IF NOT EXISTS idx_registrations_email_booked_date_parsed
  ON registrations (lower(email), (TO_DATE(booked_date, 'FMMonth DD, YYYY')));

-- Plain-trainer scoping (.ilike("booked_trainer", ...)) runs on every
-- windowed query a trainer-role account makes.
CREATE INDEX IF NOT EXISTS idx_registrations_booked_trainer ON registrations (booked_trainer);

-- Full-history search bypass (Past tab: typing a search term must find
-- sessions outside the loaded window) — trigram index makes ILIKE '%term%'
-- fast against the whole table instead of a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_registrations_parent_name_trgm ON registrations USING gin (parent_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_registrations_email_trgm ON registrations USING gin (email gin_trgm_ops);

-- Clients-tab aggregate and profile lookups by email.
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles (lower(email));
