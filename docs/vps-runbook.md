# VPS Runbook

## Read-only preflight результат

- Хост: `vps-54592`
- ОС: Debian 12, kernel `6.1.0-41-amd64`
- Системний Node: `/usr/bin/node`, версiя `v20.19.6`
- Працюючий сервiс: `dtek-api.service`
- Робоча директорiя чинного сервiсу: `/root/dtek-scraper`
- Процес Node чинного сервiсу слухає порти `8080` i `1883`
- `nginx`, `psql`, `redis-server` не виявленi в системi на момент preflight

## Фактичний стан після першого bootstrap

- Створено користувача `alerts-ua` і дерево `/srv/alerts-ua`.
- Встановлено `postgresql`, `postgresql-15-postgis-3`, `redis-server`, `nginx`.
- Розгорнуто окремий runtime Node у `/srv/alerts-ua/runtime/node`.
- Створено БД `alerts_ua` та роль `alerts_ua_app`.
- Запущено `alerts-ua-api.service` на `127.0.0.1:3100`.
- Виконано перший імпорт довідника: `1622` записи, з них `25` oblast, `126` raion, `1469` hromada, `2` city.
- Встановлено і увімкнено `alerts-ua-poll.timer` з інтервалом `60` секунд.
- Перший live polling cycle повернув `200`, створив `1622` рядки в `air_raid_state_current`, зафіксував `state_version = 1` і не створював подій, бо це був bootstrap snapshot.
- Повторні цикли вже проходять через `If-Modified-Since` і повертають `304` або `200 changed=false`, якщо upstream-рядок статусів не змінився.
- API `GET /api/v1/alerts/statuses/full` віддає live snapshot, на момент перевірки довжина `status_string` дорівнювала `1912` символам.
- Installations і subscriptions вже переведені з in-memory на PostgreSQL.
- `POST /api/v1/installations` уже створює записи в `device_installations` і `device_push_tokens`.
- На VPS виконано імпорт геометрій OCHA COD-AB: `matched_total = 1583`, з них `admin1 = 27`, `admin2 = 126`, `admin3 = 1430`.
- Після імпорту в БД є `region_geometry = 1583` і `region_geometry_lod = 4749`.
- `POST /api/v1/subscriptions/resolve-point` уже підтверджено live на координаті Києва і повертає `leaf_uid = 31`, `leaf_type = city`, `leaf_title_uk = м. Київ`.
- `GET /api/v1/map/features` уже підтверджено live по всіх шарах; у bbox Києва endpoint повернув `oblast = 3`, `raion = 9`, `hromada = 54`.
- `GET /api/v1/map/geometry-check` уже розгорнуто live як ручну debug-сторінку для візуальної перевірки геометрії; сторінка читає `/api/v1/map/regions` і `/api/v1/map/feature?uid=...`.
- `alerts-ua-push.service` встановлено і запускається успішно як oneshot unit, але `alerts-ua-push.timer` навмисно лишається вимкненим, поки на VPS не з’явиться `firebase-service-account.json`.
- Міграцію на чистий PostgreSQL завершено: колишній cold-path sync повністю вилучено з коду, схеми БД та systemd; усі дані зберігаються лише в PostgreSQL на VPS.
- На всіх етапах `dtek-api.service` залишився в стані `active`.

## Важлива примітка про скрипти

- Shell-скрипти і systemd unit файли потрібно зберігати з LF line endings.
- У репозиторії це зафіксовано в `.gitattributes`, інакше на VPS можна отримати `\r: command not found`.

## Push-доставка після міграції 0016

`alerts-ua-push` працює як постійний `simple` service, а не як oneshot за таймером. Черга лишається в PostgreSQL: записи атомарно переходять `queued → sending`, мають `claim_id`, heartbeat і lease recovery. Повтори виконуються лише після `next_attempt_at`; прострочені повідомлення переходять у `expired`. Один виклик `sendEach` містить щонайбільше 500 повідомлень.

Міграцію `backend/sql/0016_push_queue_scaling.sql` застосовувати через `psql` без `psql -1`: індекси створюються через `CONCURRENTLY`. Спочатку застосувати міграцію, потім розгорнути backend.

Разовий перехід із timer на постійний service:

```bash
systemctl disable --now alerts-ua-push.timer
cp /srv/alerts-ua/systemd/alerts-ua-push.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now alerts-ua-push.service
```

Перед цим канонічний unit потрібно оновити з `infra/vps/systemd/alerts-ua-push.service`. Під час rollout і rollback перевіряти `alerts-ua-api`, `alerts-ua-push` і `dtek-api`.

Конфігурація `.env.worker`:

```env
PUSH_WORKER_CONCURRENCY=2
PUSH_BATCH_SIZE=500
PUSH_IDLE_POLL_MS=1000
PUSH_CLAIM_LEASE_MS=120000
PUSH_FCM_MAX_RPS=1000
PUSH_FCM_RAMP_MS=60000
PUSH_START_TTL_SECONDS=600
PUSH_END_TTL_SECONDS=300
PUSH_LEVEL_CHANGED_TTL_SECONDS=180
PUSH_TOKEN_SUCCESS_UPDATE_INTERVAL_SECONDS=3600
```

Перевірка черги та журналів:

```bash
systemctl status alerts-ua-push.service
journalctl -u alerts-ua-push.service -n 100 --no-pager
curl -s http://127.0.0.1:3100/api/v1/system/push-stats
```

`sent_at` і percentile-метрики означають прийняття повідомлення FCM, а не фактичну доставку чи показ на пристрої. За відсутності Firebase credentials service не робить claim і періодично очікує появу файла.

## Правила безпечного спiвiснування

1. Не змiнювати `/etc/systemd/system/dtek-api.service`.
2. Не змiнювати `/root/dtek-scraper` i його env-файли.
3. Не займати порти `8080` i `1883`.
4. Не оновлювати системний Node без окремого погодження.
5. Новий backend запускати на `127.0.0.1:3100`.
6. Новий проєкт розгортати лише в `/srv/alerts-ua`.

## Базовий порядок розгортання

1. Створити користувача `alerts-ua`.
2. Створити директорiї `/srv/alerts-ua/app`, `/srv/alerts-ua/env`, `/srv/alerts-ua/data`, `/srv/alerts-ua/backups`, `/srv/alerts-ua/systemd`.
3. Встановити PostgreSQL/PostGIS, Redis та Nginx.
4. Пiдняти окремий runtime Node для `alerts-ua`.
5. Створити окрему БД `alerts_ua` i окремого PostgreSQL role.
6. Скопiювати backend release до `/srv/alerts-ua/app/current`.
7. Встановити systemd units з каталогу `infra/vps/systemd`.
8. Додати окремий Nginx site з `infra/vps/nginx/alerts-ua.conf`.
9. Пiсля кожного кроку перевiряти, що `dtek-api.service` лишається доступним.
