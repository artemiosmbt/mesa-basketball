-- Add session_price column to store the price paid at registration.
-- For full camp: stores total camp price paid (e.g. $290).
-- For drop-in: stores per-day drop-in price (e.g. $100).
-- Used to calculate the correct 50% late cancellation fee.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS session_price INTEGER;

-- Add is_full_camp flag to distinguish full camp packages from drop-in days.
-- Full camp: all days registered together; only the entire camp can be cancelled.
-- Drop-in: individual days that can be cancelled or rescheduled independently.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS is_full_camp BOOLEAN DEFAULT FALSE;
