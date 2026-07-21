-- Several money columns were declared INTEGER, which can only store whole
-- dollars. Private/group-private session pricing is duration-based
-- (rate * minutes/60) and routinely produces fractional dollar amounts for
-- any duration that isn't a whole-hour multiple (e.g. a 75-minute session at
-- $150/hr = $187.50) — every write of such a value to one of these columns
-- fails outright with "invalid input syntax for type integer," crashing the
-- whole booking/cancel/reschedule request rather than merely rounding it.
-- Converting to NUMERIC(10,2) is the same type already used correctly for
-- every amount column on late_fee_events.
ALTER TABLE registrations ALTER COLUMN session_price TYPE numeric(10, 2);
ALTER TABLE registrations ALTER COLUMN camp_day_late_fee TYPE numeric(10, 2);
ALTER TABLE registrations ALTER COLUMN camp_drop_in_rate TYPE numeric(10, 2);
ALTER TABLE registrations ALTER COLUMN camp_day_refund_issued TYPE numeric(10, 2);
ALTER TABLE registrations ALTER COLUMN applied_account_credit TYPE numeric(10, 2);
ALTER TABLE account_credits ALTER COLUMN balance TYPE numeric(10, 2);
