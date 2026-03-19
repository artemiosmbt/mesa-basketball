-- Rewards & Referral System — Supabase Schema Changes
-- Run these in the Supabase SQL editor before deploying

-- 1. Add referral_code column to registrations
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS referral_code text;

-- 2. Add is_free column to registrations
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS is_free boolean DEFAULT false;

-- 3. Create referral_credits table
CREATE TABLE IF NOT EXISTS referral_credits (
  email text PRIMARY KEY,
  credits int DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- 4. (Optional) Index for fast referral code lookups
CREATE INDEX IF NOT EXISTS idx_registrations_referral_code ON registrations (referral_code);
