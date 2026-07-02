-- The earlier booked_trainer backfill only covered private/group-private
-- bookings. Weekly/camp bookings now also store a trainer (from the new
-- Trainer column on the Weekly Group Schedule sheet), so backfill existing
-- confirmed weekly/camp rows the same way — there's only been one trainer
-- until now.
UPDATE registrations
SET booked_trainer = 'Artemios Gavalas'
WHERE type IN ('weekly', 'camp')
  AND booked_trainer IS NULL;
