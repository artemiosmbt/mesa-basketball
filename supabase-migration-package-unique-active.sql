-- Closes a double-purchase race in POST /api/packages: the route checks
-- hasPendingOrActivePackage(email, monthYear) and only afterward inserts the
-- new monthly_packages row — two concurrent requests for the same email+
-- month (double-click, slow-response retry, two tabs) can both pass that
-- check before either row exists, each spawning its own Stripe Checkout
-- Session and, if both complete, double-charging the client. This partial
-- unique index makes the second INSERT fail at the database level instead;
-- enrollInPackage() in src/lib/supabase.ts translates that failure back into
-- the same "You already have a package for this month" error the pre-check
-- already returns for the non-racing case, with any account credit applied
-- to the losing request refunded exactly like any other enrollInPackage
-- failure. lower(email) since normal writes always store it lowercased
-- already, but the constraint shouldn't depend on that holding forever.
CREATE UNIQUE INDEX IF NOT EXISTS monthly_packages_active_pending_unique
ON monthly_packages (lower(email), month_year)
WHERE status IN ('active', 'pending_payment');
