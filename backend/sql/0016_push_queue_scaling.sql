-- 0016: масштабирование и надёжность push-outbox
--
-- Применять через psql БЕЗ ключа -1: CREATE/DROP INDEX CONCURRENTLY
-- нельзя выполнять внутри транзакции.

ALTER TABLE notification_dispatches
  ADD COLUMN IF NOT EXISTS state_version BIGINT NULL,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS claim_id UUID NULL;

-- NOT NULL специально не устанавливается: таблица содержит миллионы
-- исторических строк. Все новые записи получают default, активная очередь
-- заполняется ниже, а исторические NULL не участвуют в claim.
ALTER TABLE notification_dispatches
  ALTER COLUMN next_attempt_at SET DEFAULT NOW();

ALTER TABLE notification_dispatches
  DROP CONSTRAINT IF EXISTS notification_dispatches_status_check;

ALTER TABLE notification_dispatches
  ADD CONSTRAINT notification_dispatches_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'deduplicated', 'skipped', 'expired'));

UPDATE notification_dispatches nd
SET state_version = e.state_version
FROM air_raid_events e
WHERE nd.event_id = e.event_id
  AND nd.state_version IS NULL
  AND nd.status = 'queued';

UPDATE notification_dispatches
SET next_attempt_at = COALESCE(next_attempt_at, queued_at),
    priority = CASE dispatch_kind WHEN 'end' THEN 0 WHEN 'start' THEN 10 ELSE 50 END,
    expires_at = COALESCE(
      expires_at,
      queued_at + CASE dispatch_kind
        WHEN 'start' THEN INTERVAL '10 minutes'
        WHEN 'end' THEN INTERVAL '5 minutes'
        ELSE INTERVAL '3 minutes'
      END
    )
WHERE status = 'queued';

UPDATE notification_dispatches
SET status = 'expired',
    provider_error_code = 'EXPIRED_BEFORE_ROLLOUT'
WHERE status = 'queued'
  AND expires_at <= NOW();

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_level_version_dedupe
  ON notification_dispatches(subscription_id, state_version, alert_level)
  WHERE dispatch_kind = 'level_changed' AND state_version IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_claimable
  ON notification_dispatches(priority, next_attempt_at, queued_at)
  WHERE status = 'queued';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_queued_subscription
  ON notification_dispatches(subscription_id, state_version, dispatch_kind)
  WHERE status = 'queued';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_sending
  ON notification_dispatches(claimed_at)
  WHERE status = 'sending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_sent_metrics
  ON notification_dispatches(sent_at DESC)
  WHERE status = 'sent';

DROP INDEX CONCURRENTLY IF EXISTS idx_notification_dispatches_queued;
