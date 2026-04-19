-- Set session timezone for Kyiv (Europe/Kyiv)
-- This ensures all timestamps in this session are interpreted and displayed in Kyiv timezone
ALTER DATABASE alerts_ua SET timezone = 'Europe/Kyiv';

-- For all new sessions, set the timezone to Kyiv
-- This is important for any functions that use NOW() or CURRENT_TIMESTAMP
SET timezone TO 'Europe/Kyiv';

-- Verify the current timezone setting
-- SELECT current_setting('timezone');
