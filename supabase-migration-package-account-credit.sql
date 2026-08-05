ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS applied_account_credit numeric(10,2) DEFAULT 0;
