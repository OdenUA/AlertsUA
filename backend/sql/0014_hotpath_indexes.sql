-- 0014: индексы горячего пути
--
-- ВАЖНО: CREATE INDEX CONCURRENTLY нельзя выполнять внутри транзакции —
-- применять через psql БЕЗ ключа -1 (обычный запуск psql -f подходит):
--   psql "$DATABASE_URL" -f 0014_hotpath_indexes.sql
--
-- Покрывает:
--  * push-воркер (каждые 15 c): SELECT ... WHERE status='queued'
--    ORDER BY queued_at — раньше seq scan по 3.7 млн строк notification_dispatches;
--  * /alerts/statuses/delta: WHERE state_version > N по air_raid_events (1.8 млн строк);
--  * synchronizeRuntimeState: события WHERE state_version = N;
--  * баннер громады: история air_raid_events по (uid, event_kind, occurred_at);
--  * загрузка активных FCM-токенoв по installation_id (FK-колонка была без индекса).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_dispatches_queued
  ON notification_dispatches(queued_at ASC)
  WHERE status = 'queued';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_air_raid_events_state_version
  ON air_raid_events(state_version ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_air_raid_events_uid_kind_occurred
  ON air_raid_events(uid, event_kind, occurred_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_push_tokens_installation_active
  ON device_push_tokens(installation_id)
  WHERE is_active = TRUE;
