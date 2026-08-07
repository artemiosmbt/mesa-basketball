-- New preference: daily group-session awareness emails, distinct from
-- marketing_emails. Defaults to true (opt-out) for every existing and future
-- profile, per the owner's explicit choice — different from sms_consent's
-- opt-in default. Never re-surfaced during registration; settings-page-only
-- toggle from here on.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS reminder_emails BOOLEAN DEFAULT true;
