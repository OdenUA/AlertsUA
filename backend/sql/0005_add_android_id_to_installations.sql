-- Add android_id column to device_installations table
-- This allows preserving subscriptions across app reinstalls

ALTER TABLE device_installations
ADD COLUMN IF NOT EXISTS android_id TEXT NULL;

-- Create index for faster lookups by android_id
CREATE INDEX IF NOT EXISTS idx_device_installations_android_id ON device_installations(android_id) WHERE android_id IS NOT NULL;
