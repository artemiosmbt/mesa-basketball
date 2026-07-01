-- Adds a trainer column so two private sessions at the same date/time/location
-- run by different trainers are tracked as separate bookings instead of one
-- trainer's booking blocking the other's slot as "already booked."
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS booked_trainer TEXT;

-- Backfill existing private bookings — until now there was only one trainer.
UPDATE registrations
SET booked_trainer = 'Artemios Gavalas'
WHERE type IN ('private', 'group-private')
  AND booked_trainer IS NULL;
