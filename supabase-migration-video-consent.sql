-- Add video_consent column to profiles table
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS video_consent BOOLEAN DEFAULT true;
