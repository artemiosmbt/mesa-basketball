ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS is_paid boolean DEFAULT false;
