ALTER TABLE air_raid_events
  ADD COLUMN IF NOT EXISTS alert_type text NOT NULL DEFAULT 'air_raid';
