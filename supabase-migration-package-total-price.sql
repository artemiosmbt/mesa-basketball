-- Stores the price actually charged at enrollment time. Package
-- cancellation refunds previously recomputed the refund amount by calling
-- packagePrice(package_type) again at cancel time — if the business ever
-- changes package pricing between enrollment and cancellation, that
-- recompute silently refunds/credits the WRONG amount (not what the client
-- actually paid). This column is the source of truth for refunds going
-- forward; existing rows are backfilled from the current rate since that's
-- the best information available for packages enrolled before this column
-- existed.
ALTER TABLE monthly_packages ADD COLUMN IF NOT EXISTS total_price numeric(10,2);

UPDATE monthly_packages
SET total_price = CASE package_type WHEN 4 THEN 475 WHEN 8 THEN 900 END
WHERE total_price IS NULL;
