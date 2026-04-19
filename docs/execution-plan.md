# План виконання

Оновлено: 2026-04-18

Цей файл фіксує поточний стан реалізації проєкту: що вже підтверджено в коді та на VPS, а що ще потрібно доробити.

## Позначення

- [x] Зроблено
- [ ] Ще потрібно зробити

## 1. Основа проєкту та інфраструктура VPS

- [x] Створено monorepo з каталогами `backend`, `android-app`, `infra`, `supabase`, `docs`.
- [x] Для нового сервісу підготовлено окреме дерево `/srv/alerts-ua` на VPS.
- [x] Піднято окремий runtime Node.js для нового проєкту без зміни системного Node чинного сервісу.
- [x] Встановлено PostgreSQL + PostGIS, Redis та Nginx.
- [x] Створено окрему БД `alerts_ua` та роль `alerts_ua_app`.
- [x] Запущено `alerts-ua-api.service` на `127.0.0.1:3100`.
- [x] На всіх етапах збережено працездатність чинного `dtek-api.service`.
- [ ] Довести публічний reverse proxy до production-ready стану.
- [ ] Додати повноцінний backup/restore сценарій для PostgreSQL.
- [ ] Додати окремий health/ops сценарій для регулярного release/update процесу.

## 2. Довідник регіонів та імпорт XLSX

- [x] Локальний файл `alerts.in.ua _ Райони, області, громади.xlsx` зафіксовано як primary import source.
- [x] Реалізовано реальний importer на `exceljs`.
- [x] Дані з XLSX імпортуються в `region_catalog` та `region_import_runs`.
- [x] Ієрархію виправлено на читання зверху вниз: `область -> район -> громада`.
- [x] Виправлено відому помилку джерела для Волинської області (`uid` 38, 39, 40, 41).
- [x] Оновлений імпорт уже повторно застосовано на live VPS.
- [ ] Додати автоматичну валідацію змін snapshot-файлу перед імпортом.
- [ ] Додати diff-звіт між попередньою та новою версією довідника.

## 3. Polling alerts.in.ua та стан тривог

- [x] Реалізовано worker опитування `alerts.in.ua` через `/v1/iot/active_air_raid_alerts.json`.
- [x] Додано `Authorization: Bearer <token>` та підтримку `If-Modified-Since` / `Last-Modified`.
- [x] Кожен цикл записується в `alert_poll_cycles`.
- [x] Перший bootstrap snapshot записується в `air_raid_state_current`.
- [x] Реалізовано DB-backed endpoint-и `/api/v1/alerts/statuses/full` та `/api/v1/alerts/statuses/delta`.
- [x] На VPS встановлено та увімкнено `alerts-ua-poll.timer` з інтервалом 60 секунд.
- [x] Повторні цикли вже проходять по гілці `304` або `changed=false`, якщо upstream не змінився.
- [ ] Перевірити на живій зміні upstream, що `started/ended/state_changed` створюються саме так, як очікується.
- [ ] Додати явний backoff/поведінку деградації для `429 Too Many Requests`.
- [ ] Додати зручну діагностику останніх poll cycles через окремий технічний endpoint або SQL-view.

## 4. Підписки, runtime state та push

- [x] Замінено in-memory реалізацію installations/subscriptions на PostgreSQL.
- [x] Реалізовано server-side `resolve-point` через PostGIS до `leaf_uid`, `raion_uid`, `oblast_uid`.
- [x] Реалізовано `subscription_runtime_state` і обчислення `effective_state` по ієрархії.
- [x] Додано постановку в чергу push-повідомлень на `start` та `end` через `notification_dispatches`.
- [x] Реалізовано worker dispatch-а через Firebase Admin SDK.
- [x] Результати доставки зберігаються в `notification_dispatches` та `device_push_tokens`.
- [x] Дедуплікацію push закладено на комбінацію `(subscription_id, event_id, dispatch_kind)` через `UNIQUE` + `ON CONFLICT DO NOTHING`.
- [x] Завантажено реальні геометрії в `region_geometry`, і `resolve-point` уже визначає фактичний leaf region по координаті.
- [ ] Додати на VPS `firebase-service-account.json` і після цього увімкнути `alerts-ua-push.timer`.

## 5. Android-клієнт

- [x] Створено Kotlin Android scaffold.
- [x] Додано Compose shell та WebView-обгортку для Leaflet.
- [x] Підключено Firebase Messaging.
- [x] Додано логування FCM token у застосунку.
- [x] Підключено `google-services.json` через Google Services Gradle plugin.
- [x] Android-клієнт підключено до реальних backend endpoint-ів: WebView отримує `/map/config` і `/map/features`, а застосунок викликає `/subscriptions/resolve-point`.
- [x] Додано редагований `Backend API URL` у застосунку; за замовчуванням для емулятора використовується `http://10.0.2.2:43100/api/v1`.
- [x] Зібрано локальний debug APK (`app/build/outputs/apk/debug/app-debug.apk`) через Gradle 8.7 + JDK 21.
- [ ] Реалізувати пошук адреси та вибір точки на мапі.
- [ ] Реалізувати екран керування підписками.
- [x] Додано live overlays статусів на мапі.
- [ ] Провести перший повний запуск Android MVP на реальному Firebase проєкті.

## 6. Supabase cold path

- [x] Підготовлено базову схему cold path у репозиторії.
- [x] На VPS збережено `SUPABASE_URL`, `SUPABASE_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`.
- [x] На VPS збережено `SUPABASE_PUBLISHABLE_KEY` та `SUPABASE_SECRET_KEY`.
- [x] Для зворотної сумісності `SUPABASE_SERVICE_KEY` на VPS виставлено в той самий server-side secret key.
- [x] Реалізовано `supabase_outbox` worker і hot-path enqueue для `regions_ref`, `devices`, `device_push_tokens`, `subscriptions`, `alert_event_log`, `notification_log`.
- [x] Sync-capable backend build уже зібрано локально і розгорнуто на VPS.
- [x] Додано non-interactive script `npm run apply:supabase-schema` для застосування `supabase/migrations/0001_initial.sql` через Supabase Management API.
- [ ] Застосувати remote schema з `supabase/migrations/0001_initial.sql` у фактичному Supabase-проєкті; поточний bootstrap sync блокується через відсутні `public` таблиці й помилку `PGRST205` у schema cache.
- [ ] Після застосування schema повторно виконати bootstrap sync і звірити row counts у cold path.
- [ ] Увімкнути `alerts-ua-sync.timer` тільки після успішного bootstrap і валідації cold-path даних.
- [ ] Перевірити фактичне місячне egress-навантаження після запуску sync.

## 7. Геометрія та карта

- [x] Завантажити та нормалізувати повні геометрії в PostGIS.
- [x] Підготувати `region_geometry_lod` для різних рівнів деталізації.
- [x] Реалізувати backend endpoint видачі GeoJSON по viewport.
- [x] Підтверджено live geometry import на VPS: `region_geometry = 1583`, `region_geometry_lod = 4749`.
- [x] Підтверджено live `/api/v1/map/features` у bbox Києва: `oblast = 3`, `raion = 9`, `hromada = 54`.
- [x] Додано ручну web-сторінку для візуальної перевірки геометрії: `/api/v1/map/geometry-check`; сторінка показує Leaflet-карту, ієрархічний список областей/районів/громад і вмикає/вимикає заливку по кліку.
- [x] Підключено рендер меж областей, районів і громад у мобільному клієнті через live backend GeoJSON overlays.
- [ ] Зменшити unmatched-залишок між OCHA geometry та `region_catalog` для Криму, Києва/Севастополя і частини legacy-назв.

## 8. Найближчі практичні кроки

1. Застосувати remote schema з `supabase/migrations/0001_initial.sql` у Supabase і повторно прогнати bootstrap sync.
	Практичний шлях: `cd backend && npm run apply:supabase-schema`, якщо в shell уже є `SUPABASE_ACCESS_TOKEN` і `SUPABASE_PROJECT_ID`.
2. Після успішної валідації cold path увімкнути `alerts-ua-sync.timer`.
3. Додати `firebase-service-account.json` на VPS і увімкнути `alerts-ua-push.timer`.
4. Провести повний прогін Android MVP на емуляторі/пристрої з реальним Firebase push.
5. Зменшити unmatched-залишок між OCHA geometry та `region_catalog`.
6. Довести публічний production reverse proxy та backup/ops сценарії.
