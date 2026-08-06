-- Which trainer tier a monthly package was purchased for — 'artemios' (the
-- higher, owner rate) or 'other' (the flat part-time-trainer rate). A
-- package only ever covers a private session whose trainer matches this
-- tier (see allocatePackageCoverage in api/register/route.ts).
ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS trainer_tier TEXT;

-- Backfill existing packages — until now every package was Artemios-tier,
-- since no other trainer existed yet.
UPDATE monthly_packages
SET trainer_tier = 'artemios'
WHERE trainer_tier IS NULL;
