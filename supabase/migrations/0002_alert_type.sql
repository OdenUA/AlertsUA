ALTER TABLE air_raid_state_current
  ADD COLUMN IF NOT EXISTS alert_type text NOT NULL DEFAULT 'air_raid';
