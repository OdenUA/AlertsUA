-- 0013: допустимые статусы device_installations
--
-- Код (installations.service.ts: reclaim/self-heal) помечает старые
-- дубликаты установки статусом 'replaced', но CHECK-констрейнт из 0001
-- допускал только ('active','revoked'). На проде такие записи молча
-- блокировались (SELECT count(*) WHERE status='replaced' = 0), т.е.
-- миграция FCM-токена/подписок при переустановке фактически не работала.
--
-- Живой констрейнт на VPS: device_installations_status_check
-- (проверено 2026-10-24, строк со статусом 'replaced' нет).

ALTER TABLE device_installations
  DROP CONSTRAINT IF EXISTS device_installations_status_check;

ALTER TABLE device_installations
  ADD CONSTRAINT device_installations_status_check
  CHECK (status IN ('active', 'revoked', 'replaced'));
