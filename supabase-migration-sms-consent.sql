-- Add SMS consent column to registrations table
ALTER TABLE registrations
ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT false;
