-- 0015: удалить материализованное представление threat_overlays_fast
--
-- Триггеры из 0003/0004 на КАЖДУЮ вставку/обновление threat_vectors и
-- threat_visual_overlays синхронно выполняли REFRESH MATERIALIZED VIEW
-- CONCURRENTLY внутри транзакции записи. Матвью не читается ничем в
-- backend/src (проверено grep'ом 2026-10-24), на VPS ссылок в скриптах/
-- cron нет (30 тыс. seq_scan объясняются самими REFRESH) — это чистая
-- write-амплификация парс-воркера.

DROP TRIGGER IF EXISTS trigger_refresh_threat_overlays_vectors ON threat_vectors;
DROP TRIGGER IF EXISTS trigger_refresh_threat_overlays_overlays ON threat_visual_overlays;
DROP FUNCTION IF EXISTS refresh_threat_overlays_fast();
DROP MATERIALIZED VIEW IF EXISTS threat_overlays_fast;
