-- Add alert_level tracking for push notifications
-- Supports red/yellow level differentiation and level_changed dispatch kind

-- 1. Add effective_alert_level to subscription_runtime_state
ALTER TABLE subscription_runtime_state
  ADD COLUMN IF NOT EXISTS effective_alert_level TEXT NOT NULL DEFAULT 'red';

-- 2. Make event_id nullable in notification_dispatches (for level_changed dispatches)
ALTER TABLE notification_dispatches
  ALTER COLUMN event_id DROP NOT NULL;

-- 3. Add alert_level column to notification_dispatches
ALTER TABLE notification_dispatches
  ADD COLUMN IF NOT EXISTS alert_level TEXT NOT NULL DEFAULT 'red';

-- 4. Expand dispatch_kind CHECK constraint to include 'level_changed'
ALTER TABLE notification_dispatches
  DROP CONSTRAINT IF EXISTS notification_dispatches_dispatch_kind_check;

ALTER TABLE notification_dispatches
  ADD CONSTRAINT notification_dispatches_dispatch_kind_check
  CHECK (dispatch_kind IN ('start', 'end', 'level_changed'));

-- 5. Drop old unique constraint (handle PostgreSQL identifier truncation)
ALTER TABLE notification_dispatches
  DROP CONSTRAINT IF EXISTS notification_dispatches_subscription_id_event_id_dispatch_kind_key;

ALTER TABLE notification_dispatches
  DROP CONSTRAINT IF EXISTS notification_dispatches_subscription_id_event_id_dispatch_k_key;

-- For event-based dispatches (start/end): unique per subscription+event+kind+level
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dispatches_event_dedupe
  ON notification_dispatches (subscription_id, event_id, dispatch_kind, alert_level)
  WHERE event_id IS NOT NULL;

-- level_changed dedup is handled in application code (check before INSERT)
