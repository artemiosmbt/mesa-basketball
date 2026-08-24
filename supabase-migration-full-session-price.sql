-- The undiscounted per-row price a weekly session would cost with ZERO volume
-- discount applied, captured at booking time — mirrors session_price, which is
-- the actual (post-discount) amount charged. Needed by computeBulkWeeklySettlement
-- (src/lib/booking-finalize.ts) to true up a bulk-discounted booking's remaining
-- sessions when cancelling/rescheduling one drops the batch below the 4- or
-- 8-session discount threshold — that math needs each row's true full price,
-- not a value re-derived from session_price and a guessed discount tier.
-- numeric(10,2) to match session_price's own type (see
-- supabase-migration-money-columns-numeric.sql).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS full_session_price numeric(10,2);
