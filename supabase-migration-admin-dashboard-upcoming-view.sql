-- Supabase's query client (PostgREST) can only filter on real columns, not
-- on an arbitrary function call like parse_booked_date(booked_date)
-- directly in a .gte()/.lte() call. This view exposes that parsed value as
-- a normal selectable/filterable column, backed by the functional index
-- already created in supabase-migration-admin-dashboard-indexes.sql — a
-- plain SELECT * plus one computed column, which Postgres treats as an
-- automatically-updatable view, so it behaves like a normal table for
-- read queries. Read-only usage here regardless (only SELECTed from, never
-- written to).
CREATE OR REPLACE VIEW registrations_with_parsed_date AS
SELECT *, parse_booked_date(booked_date) AS booked_date_parsed
FROM registrations;
