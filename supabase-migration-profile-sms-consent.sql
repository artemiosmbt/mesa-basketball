-- Add sms_consent and marketing_emails columns to profiles table
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS marketing_emails BOOLEAN DEFAULT true;
