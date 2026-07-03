-- Support cancelling individual days out of a full-week camp booking.

-- Late-fee OUTCOME for one specific camp day, persisted at the moment it's
-- cancelled (a fact about that action/time, not recomputed later) so fees
-- from separate cancel actions across a camp group can be summed.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS camp_day_late_fee INTEGER DEFAULT 0;

-- Real per-day drop-in rate (already multiplied by kid count, same
-- convention as session_price), captured at registration time for
-- full-camp rows. session_price alone stores only the capped full-week
-- total and can't be used to reconstruct the drop-in rate later.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS camp_drop_in_rate INTEGER;
