# Техническая спецификация: Android-клиент системы мониторинга воздушных тревог

Спецификация для AI-агента, реализующего Android-приложение, которое
использует **уже существующий** серверный API (NestJS, префикс `/api/v1`).
Серверная часть не разрабатывается; она описана ниже как фиксированный
контракт. Вопросы визуального оформления вне области спецификации — описывается
только поведение, данные и алгоритмы.

---

## 1. Назначение клиента

Клиент обеспечивает:
1. Отображение карты Украины со слоями активных тревог (области/районы/общины),
   границ, оккупированных территорий и угрозовых оверлеев (БПЛА, ракеты,
   авиация, KAB).
2. Polling серверных бандлов и мгновенное обновление по FCM-push.
3. Подписки пользователя: создание пина по координатам (тап по карте или
   геолокация), список пинов, удаление; серверный `resolve-point` для
   разрешения координат в иерархию региона.
4. Push-уведомления о начале/окончании тревоги в подписанном регионе,
   с настраиваемым звуком/вибрацией.
5. Офлайн-фолбэк: статическая геометрия регионов и граница Украины поставляются
   в APK как ассеты и рисуются без сети (без статусов).
6. Регистрацию установки (`/installations`) и управление FCM-токеном.

## 2. Подключение к существующему серверу

### 2.0. Общие параметры

- **Базовый URL**: `buildConfigField` `DEFAULT_API_BASE_URL` со значением
  `http://173.242.53.129/api/v1` (сервер по IP, HTTP без домена — в манифесте
  `usesCleartextTraffic="true"`). Пользователь может переопределить в
  настройках (SharedPreferences `api_base_url`); все вызовы принудительно
  нормализуются к суффиксу `/api/v1`. При смене URL — force-refetch
  менеджеров слоёв.
- **Авторизация**: заголовок `Authorization: Bearer <installation_token>`.
  Токен извлекается сервером regex `/^Bearer\s+/i`. Токен клиент получает:
  1. при первом запуске — из ответа `POST /installations`;
  2. при переустановке приложения — из фолбэка `GET /subscriptions?android_id=...`
     (сервер перевыпускает токен существующей установки).
  Токен хранится в SharedPreferences `installation_token`. **401** «Невірний
  токен встановлення.» — нет/невалидный заголовок; **401** «Встановлення не
  знайдено.» — по токену не найдена активная установка (в таком случае —
  перерегистрация через `POST /installations`).
- **Единый формат ошибок** (все эндпоинты):
  ```json
  { "error": { "code": 404, "message_uk": "…" }, "request_id": "<uuid>", "path": "<url>" }
  ```
  `message_uk` — строка или массив строк (400, ошибки валидации).
- **Времена**: Postgres-текст `2025-01-01 12:00:00.000+02` → `OffsetDateTime`,
  fallback — Europe/Kyiv.

### 2.1. POST /installations — регистрация установки

Запрос (обязательные: platform, locale, app_version ≤32, app_build ≤32,
device_model ≤128, fcm_token; опциональные: notifications_enabled
default true, android_id ≤64):

```json
{ "platform": "android", "locale": "uk-UA", "app_version": "0.8.4", "app_build": "44",
  "device_model": "Pixel 8", "fcm_token": "<FCM>", "notifications_enabled": true, "android_id": "<ANDROID_ID>" }
```

`app_version`/`app_build` — **строго из `BuildConfig.VERSION_NAME` /
`VERSION_CODE`** (в эталоне захардкожено — ошибка, не повторять).

Ответ:

```json
{ "installation_id": "uuid", "installation_token": "uuid",
  "locale": "uk", "server_time": "2025-01-01 12:00:00.000+02",
  "push_defaults": { "notify_on_start": true, "notify_on_end": true } }
```

- `installation_token` возвращается **только здесь** и в android_id-фолбэке
  GET /subscriptions — сохранить сразу.
- Эндпоинт **не идемпотентен**: каждый вызов создаёт новую установку. Клиент
  должен регистрироваться один раз и далее использовать фолбэк по android_id.
- Сервер сразу активирует fcm_token; если такой токен был у другой установки —
  при совпадении android_id подписки мигрируют, иначе старые удаляются.

### 2.2. PUT /installations/me/push-token

Запрос `{ "fcm_token": "<FCM>" }` (Bearer). Ответ:
`{ "token_status": "updated", "updated_at": "<kyiv timestamp>" }`.
Ошибки: 400 — пустой токен; 401 — нет валидного Bearer. Вызывается из
`onNewToken` и при смене токена. Также есть `PATCH /installations/me`
(`app_version?`, `app_build?`, `notifications_enabled?` →
`{ installation_id, updated_at }`).

### 2.3. CRUD /subscriptions

**POST /subscriptions** (Bearer), запрос:

```json
{ "latitude": 50.45, "longitude": 30.523,
  "notify_on_start": true, "notify_on_end": true,
  "label_user": "Громада | Район | Область" }
```

⚠️ `label_user` — **семантический**: значения `"Район"` / `"Область"`
переключают scope подписки (пуши приходят по всему району/области), иначе —
по общине/городу. Обычная пользовательская метка ограничена ≤120 символов.

Ответ — один пин:

```json
{ "subscription_id": "uuid", "installation_id": "uuid", "label_user": "Громада",
  "address_uk": "Точка в межах «…»", "latitude": 50.45, "longitude": 30.523,
  "leaf_uid": 123, "raion_uid": 45, "oblast_uid": 14, "leaf_title_uk": "…",
  "notify_on_start": true, "notify_on_end": true, "is_active": true,
  "current_status": "A | P | N | ' '",
  "created_at": "<timestamptz>", "updated_at": "<timestamptz>" }
```

`current_status` — effective-статус из runtime-state (`' '` при отсутствии).
Ошибки: 401, 400 (валидация), 404 (точка не резолвится).

**GET /subscriptions** (Bearer) → `{ "subscriptions": [pin, …] }`
(ORDER BY created_at ASC, те же поля пина).
Фолбэк без Bearer: `GET /subscriptions?android_id=<ANDROID_ID>` → при найденной
установке `{ "subscriptions": [...], "installation_token": "<новый uuid>" }`
(сохранить токен!), иначе `{ "subscriptions": [] }`.

**PATCH /subscriptions/{id}** (Bearer): все опциональны —
`label_user?`, `notify_on_start?`, `notify_on_end?`, `is_active?` →
обновлённый пин. 404 «Підписку не знайдено.» — пин не принадлежит установке.

**DELETE /subscriptions/{id}** (Bearer) →
`{ "deleted": true, "subscription_id": "<id>" }`. Чужой/отсутствующий пин —
404 (403 не возникает).

### 2.4. POST /subscriptions/resolve-point

Запрос `{ "latitude": number, "longitude": number }` (IsLatitude/IsLongitude →
400). Ответ:

```json
{
  "address_uk": "Точка в межах «<leaf_title_uk>»",
  "resolved_region": {
    "leaf_uid": 123, "leaf_type": "hromada | city",
    "hromada_title_uk": "…", "hromada_status": "A|P|N|' '",
    "raion_uid": 45, "raion_title_uk": "…", "raion_status": "A|P|N|' '|null",
    "oblast_uid": 14, "oblast_title_uk": "…", "oblast_status": "A|P|N|' '|null",
    "active_from": "2025-01-01 10:00:00+02 | null",
    "oblast_history": { "active": [...], "today": [...], "yesterday": [...] },
    "leaf_title_uk": "…",
    "current_status": "A|P|N|' '",
    "current_status_label_uk": "Повітряна тривога | Часткова повітряна тривога | Немає тривоги | Немає даних"
  },
  "latitude": 50.45, "longitude": 30.52
}
```

- `raion_status`/`oblast_status` — серверные агрегаты (`A` — сам регион или
  все leaf-дочки активны; `P` — частично; `N` — нет активных; `' '` — нет
  данных; `null` — уровня нет, например city без raion).
- `active_from` — минимальный среди уровней со статусом `A`, иначе null.
- `oblast_history` — элементы **ровно**:
  `{ region_title_uk, raion_title_uk: string|null, started_at, ended_at: string|null, alert_type }`
  (ни `uid`, ни `region_type` в ответе нет — идентификация по названиям).
  `active` — текущие активные; `today`/`yesterday` — по дате начала в
  Europe/Kyiv. Для Киевской области (uid 14) в каждый непустой массив
  добавляется запись «м. Київ».
- Особый случай: для города Киева сервер подставляет `oblast_uid` Киевской
  области, если геометрия города не отдаёт область.
- **404** — точка не резолвится ни в общину, ни в район. Ответ кэшируется
  сервером ~5 мин по координатам с точностью 0.001 (~100 м) — статусы внутри
  могут отставать до 5 минут.

### 2.5. GET /map/bundle

```json
{
  "state_version": 12345,
  "generated_at": "<kyiv timestamp>",
  "active_alert_uids": [123, …],
  "status_lookup": { "123": { "status": "A|P|N", "alert_type": "air_raid|…", "alert_level": "red|yellow" } },
  "alerts_layer": { "features": [ { "uid": 1, "region_type": "hromada", "alert_type": "…", "alert_level": "red" } ] },
  "layer_counts": { "oblast:low": N, "oblast:medium": N, "raion:medium": N, "raion:high": N, "hromada:medium": N, "hromada:high": N },
  "active_alerts_count": N,
  "simplified_oblast_count": N,
  "occupied_territories_count": N,
  "threat_overlay_count": 0
}
```

- `status_lookup` включает только регионы со статусом ≠ `' '` — отсутствие
  uid трактовать как «нет данных/нет тревоги». Ключи после десериализации —
  строки.
- Геометрий в бандле **нет** (только ассеты) — бандл это `state_version` +
  lookup + служебные счётчики.
- `threat_overlay_count` здесь всегда 0 (заглушка) — угрозы только из
  `/map/threat-overlays`.

### 2.6. GET /map/threat-overlays

Параметры: `sources=@kpszsu,@war_monitor` (список каналов; если не передан —
только дефолтный канал). Ответ без пагинации:

```json
{
  "generated_at": "<kyiv timestamp>",
  "overlays": [
    { "overlay_id": "uuid", "vector_id": "uuid",
      "threat_kind": "uav|tactical_aviation|ballistic|kab|missile|unknown|…",
      "confidence": 0.85,
      "movement_bearing_deg": 235,
      "icon_type": "…", "color_hex": "#RRGGBB",
      "occurred_at": "2025-01-01 12:00:00+02",
      "expires_at": "2025-01-01 12:30:00+02 | null",
      "message_text": "… | null", "message_date": "<timestamp> | null",
      "source_excerpt": "… | null", "channel_ref": "12345 | null",
      "marker":   { "type": "Point", "coordinates": [lng, lat] },
      "corridor": { "type": "LineString", "coordinates": [[lng,lat], …] },
      "area":     { "type": "Polygon|MultiPolygon", "coordinates": … } }
  ]
}
```

- Поля `has_popup` в ответе **нет** — клиент считает угрозу «интерактивной»,
  если есть `message_text` (попап показывает текст/канал/время).
- `movement_bearing_deg`: если в БД NULL — вычислен сервером по коридору;
  `null` означает «нет данных».
- Сортировка — `render_priority ASC, occurred_at DESC`.
- Эндпоинт `/alerts/statuses/delta` **не используется** — синхронизация
  строится на `state_version` в `/map/bundle`.

## 3. Технологический стек и сборка

- **Язык/плагины**: Kotlin, AGP 9.x (встроенный Kotlin — отдельный
  `org.jetbrains.kotlin.android` НЕ применять), Compose-компилятор через
  `org.jetbrains.kotlin.plugin.compose`, `buildFeatures { compose = true;
  buildConfig = true }`.
- **SDK**: compileSdk 36, minSdk 26, targetSdk 36, Java/Kotlin target 17.
- **Ключевые зависимости**:
  - `org.maplibre.gl:android-sdk:13.6.0` (карта)
  - Compose BOM + material3, lifecycle-runtime-compose, activity-compose
  - `firebase-messaging-ktx`, `firebase-analytics-ktx`
  - `play-services-location` (FusedLocationProvider)
  - `kotlinx-coroutines-android`
  - **HTTP — чистый `HttpURLConnection` + `org.json`** (НЕ Retrofit/Ktor);
    Gson только как helper для properties фич MapLibre
  - `play-services-ads` (баннер, опционально)
  - `androidx.work:work-runtime` — явно фиксировать актуальную версию
    (транзитивная старая падает на 16КБ-страничных устройствах), напрямую
    не используется
- **Release**: minifyEnabled + shrinkResources, proguard-rules; signingConfig
  создаётся только если заданы все 4 `RELEASE_*` параметра, иначе release-сборка
  отключается (не падать на машине без ключей).
- **Манифест**: разрешения INTERNET, POST_NOTIFICATIONS, ACCESS_FINE/COARSE_LOCATION,
  AD_ID, ACCESS_NETWORK_STATE; `usesCleartextTraffic="true"` (сервер по IP без
  домена); `uses-feature vulkan required=false` (override требования MapLibre);
  Application-класс, MainActivity (single), FirebaseMessagingService с
  intent-filter MESSAGING_EVENT; google-services.json в app/.

### 3.1. Рекламный баннер (AdMob)

⚠️ **Для отдельно публикуемого приложения** (своя страница в Play, пакет
`ua.alerts.app`): AdMob запрещает показывать ad unit в приложении, для
которого он не создан, — реюз чужого unit'а рискует блокировкой аккаунта.
Поэтому: завести в AdMob **новое приложение** и **новый ad unit баннера**,
подставить их ID ниже. Все механики (AdManager, скрытие, lifecycle AdView) —
без изменений.

- **AdMob App ID**: `ca-app-pub-7267693224424927~3346267535` — meta-data
  `com.google.android.gms.ads.APPLICATION_ID` в манифесте; плюс
  `DELAY_APP_MEASUREMENT_ENABLED=false` и override
  `android.adservices.AD_SERVICES_CONFIG` (разрешение конфликта с Firebase
  Analytics).
- **Ad unit (баннер)**: `ca-app-pub-7267693224424927/6615114075`, размер
  `AdSize.BANNER`.
- Зависимость `play-services-ads`; `MobileAds.initialize` — асинхронно в IO
  из `Application.onCreate`.
- Баннер — фиксированный блок между верхней панелью и картой; `AdView`
  создаётся один раз (`remember {}`), уничтожается в `onDispose`; скрывается
  в полноэкранном режиме.
- **AdManager** (SharedPreferences `ad_prefs`): флаг `areAdsDisabled`
  управляет видимостью баннера; переключатель — пасхалка (8 быстрых тапов
  по заголовку FAQ).
- Разрешения: `ACCESS_ADSERVICES_AD_ID`, `ACCESS_ADSERVICES_ATTRIBUTION`,
  `AD_ID`.

## 4. Архитектура приложения

- **Single-Activity**, навигация через `rememberSaveable`-состояния (без
  Navigation Component): главный экран карты + bottom sheet'ы/диалоги +
  экран настроек + FAQ-sheet.
- **Без DI-фреймворка**: зависимости создаются через `remember { ... }`,
  контекст — `applicationContext`.
- Пакеты по фичам:
  - `map` — карта и все слои
  - `notifications` — FCM-сервис, шина обновлений, настройки уведомлений
  - `data` — единый `AlertsRepository` (весь HTTP)
  - `location` — получение геолокации
  - `ui` — Compose-экраны (настройки, FAQ, rate prompt)
  - `admob`, `rateprompt` — вспомогательные

### Данные

- `AlertsRepository` — класс, все сетевые вызовы на `Dispatchers.IO`, таймауты
  connect/read 15 000 мс, тихое логирование ошибок (`Log.w`), ретраи
  (bundle — до 3 раз с экспоненциальным backoff 1→8 сек; подписки — один
  повтор через 8 сек). Пользователю тосты об ошибке показываются **только
  при ручном обновлении**.
- DTO-модели: `SubscriptionPin`, `ResolvedRegion` (leafUid, leafType, цепочка
  hromada/raion/oblast с title + status + activeFrom, `oblastHistory` —
  активная/сегодня/вчера с `region_title_uk`, `raion_title_uk`, `started_at`,
  `ended_at`, `alert_type`).
- Хранение (SharedPreferences `alerts_ua_preferences`): `api_base_url`,
  `dark_mode_enabled` (null = первый запуск → системная тема), `fcm_token`,
  `installation_token`, `subscription_pins` (JSON — офлайн-кэш пинов).
  `android_id` = `Settings.Secure.ANDROID_ID`.
- При смене `api_base_url` инвалидировать applied-версии менеджеров слоёв
  (force-refetch).

## 5. Карта (ядро клиента)

### 5.1. Обёртка (NativeMapView)

- `AndroidView` над MapLibre `MapView`; lifecycle форвардится через
  `LifecycleEventObserver` (onStart/Resume/Pause/Stop/Destroy), `onLowMemory`
  — через `ComponentCallbacks2`. Polling менеджеров слоёв паузится на ON_STOP
  и возобновляется на ON_START (порог ре-фетча при возврате — 10 сек).
- Базовый стиль — OpenFreeMap: `https://tiles.openfreemap.org/styles/liberty`
  (светлая) / `.../dark` (тёмная); смена темы → повторный `map.setStyle(...)`.
- После **каждой** загрузки стиля: все кастомные слои пересоздаются
  (setStyle их стирает); подписи стиля переводятся на украинские названия —
  в SymbolLayer'ы с text-field ставится
  `["coalesce",["get","name:uk"],["get","name"]]`; тяжёлые слои стиля
  (3D-здания, landuse, hillshade, мелкие label'ы) скрываются.
- Камера: bounds = bbox Украины (`LatLngBounds.from(52.4, 40.2, 44.3, 22.1)`),
  старт — fit bounds, minZoom 4, maxZoom 11, пан-камеры ограничен bounds
  (`setLatLngBoundsForCameraTarget`), rotate/tilt жесты отключены.
- Замер холодного старта (время чтения ассетов, загрузки стиля, установки
  слоёв) — логирование через `SystemClock.elapsedRealtime`.

### 5.2. Слои тревог (AlertLayersManager)

**Источники данных.** Геометрия — сырые GeoJSON-строки из ассетов:
`map/data/oblast.geojson`, `raion.geojson`, `hromada.geojson`
(формат `{"layer":..., "features":[...]}` без пробелов), конвертируются
строковой вставкой в `{"type":"FeatureCollection",...}` и отдаются в
`GeoJsonSource` **без парсинга в объектный граф** (парсит C++-ядро).
Индекс `map/data/layer-meta.json` (uid → `{c:[lon,lat] — центр bbox,
t:title_uk, r:region_type}`) читается в объектный граф и используется для
центров/названий. Статусы — из `GET /map/bundle`.

**Инъекция статусов.** Однопроходный строковый проход по GeoJSON: после
маркера `"properties":{"uid":` вставляются
`"status":"...","alert_type":"...","alert_level":"...",`.
Пустой/отсутствующий статус трактуется как `" "` (нет тревоги), дефолтный
тип — `air_raid`, дефолтный уровень — `red`.

**Наследование статуса м. Київ**: город (`region_type=="city"`, title
нормализуется к «київ») получает статус Киевской области, если у него нет
собственного активного статуса.

**Polling.** Каждые 30 000 мс. Применяется ответ только если
`state_version > appliedStateVersion` (защита от race poll↔ручное
обновление; ручное «Обновить» применяет с `force=true`, т.е. `>=`).
Первый fetch — с retry ×3 (backoff 1→8 сек).

**Слои (порядок снизу вверх):**
1. `ua-mask` — FillLayer: мир-полигон с дырами по кольцам границы Украины
   (reversed holes) + `ua-mask-border` (Line).
2. Источники `src-oblast/raion/hromada` + `oblast-borders` (Line, 1px).
3. Fill-слои `alert-fill-oblast/raion/hromada` — фильтр `status=='A'`,
   цвет заливки data-driven от `alert_type`/`alert_level` (спец-типы
   артиллерия/городские бои — отдельной палитрой, независимо от уровня;
   красный/жёлтый уровни — своими цветами с полупрозрачностью).
4. `alert-fill-special` — заливка спец-типов по hromada-источнику
   (фильтр `status=='A'` AND `alert_type` in списке спец-типов).
5. `oblast-status-borders` — цвет линии по статусу области (A/P).
6. Оккупированные территории (из `map/data/occupied-territories.geojson`,
   нормализуется к FeatureCollection): заливка + `fillPattern` (генерируемая
   программно диагональная штриховка 10dp) + контурная линия.
7. `alert-type-icons` — SymbolLayer по центрам активных спец-типов из
   layer-meta (иконки `air-raid`, `artillery-shelling`, `urban-fights`).
8. `oblast-city-labels` — подписи обласных центров (maxZoom 7, размер
   интерполируется по zoom, ручной override позиции, uid → короткое имя).

### 5.3. Слои угроз (ThreatLayersManager)

- Источник: `GET /map/threat-overlays?sources=@kpszsu,@war_monitor` — всегда
  оба канала, фильтрация клиентская. Каналы: `@kpszsu` (Повітряні Сили),
  `@war_monitor` (War Monitor). `setThreatChannel(ref)` — только перерендер
  из кэша (null = скрыть всё).
- Polling каждые 60 000 мс. При неудачном fetch рендер всё равно выполняется
  (протухшие по времени исчезают).
- **Видимость по времени**: uav/tactical_aviation — 45 мин, ballistic —
  20 мин, остальные — 30 мин (или до `expires_at`, если задан).
- **Дуга направления**: квадратичная Безье из центра маркера в конец
  коридора, 18 сегментов, отступ серединой по Web-Mercator-пикселям при
  текущем зуме (`worldSize = 256·2^zoom`), масштабируется с zoom. Дуга не
  строится, если расстояние маркер→цель < 10 км. **Пересчёт дуг по
  `OnCameraIdleListener`** (camera-idle).
- Слои: `threat-direction-line` (дуга) → `threat-direction-arrow`
  (SymbolLayer-треугольник в точке цели, `iconRotate` по bearing, размер
  клэмпится по zoom) → `threat-icons` (28dp, `iconRotate` по bearing,
  масштаб иконок по zoom, иконки uav/shahed, kab, missile, ballistic,
  tactical_aviation; light/dark-варианты по теме).
- **Bearing**: приоритет у `movement_bearing_deg`, кроме кейса
  explicit==0 с расхождением с коридором >1° (тогда bearing по коридору);
  для `kab` с непустым коридором добавляется +135°.
- **Кластеризация**: маркеры ближе порога (28dp × density × iconScale × 0.1)
  объединяются, представитель — самый свежий; пересчёт на camera-idle.
- **Hit-test**: tolerance 20dp по слою иконок; угроза «интерактивна» (открывает
  попап), если у неё есть `message_text` — серверного флага `has_popup` нет,
  клиент определяет сам; тап по кластеру возвращает список угроз (сортировка
  по `occurredAt` desc) → попап (диалог с текстом, каналом, временем).
- **Критические угрозы** (`ballistic`, `tactical_aviation` с попапом) →
  callback `onCriticalThreatsChanged` (дедуп по `overlay_id`) →
  пульсирующий индикатор на экране (700 мс tween).

### 5.4. Контроллер карты (MapController)

- Слои пинов подписок и маркера локации — SymbolLayer с программно
  генерируемыми bitmap (canvas → BitmapDescriptor).
- **Порядок обработки тапа**: ① hit-test угроз (`threatLayersManager.hitTest`)
  → попап угрозы; ② hit-test пина (queryRenderedFeatures, tolerance 20dp,
  property `marker_id`) → детали подписки; ③ `pointInGeometry` (ray casting,
  см. `MapGeometry`) по границе Украины из ассета — тапы вне границы
  игнорируются; если внутри bbox Киева (30.23–30.83 / 50.21–50.59) —
  резолвится центр города (50.45, 30.523); ④ `onPointSelected(lat, lon)` →
  bottom sheet подписки.
- Callback'и: `onMapPageReady`, `onPointSelected`,
  `onSubscriptionMarkerTapped`, `onLocateButtonTapped`, `onToast`,
  `onThreatTapped`, `onCriticalThreatsChanged`.
- `setUserLocation(lat, lon, center)` — center=true анимирует камеру
  (min zoom 8); `zoomIn/zoomOut`; `refreshAlerts()` — форсирует оба менеджера.
- **Z-order**: после переустановки базовых слоёв AlertLayersManager уведомляет
  контроллер (`onBaseLayersReinstalled`) → угрозы и пины переустанавливаются
  поверх.

### 5.5. Экран карты (AlertMapScreen)

- Кнопки масштаба и «моя локация» (36dp), snackbar для тостов, индикатор
  критических угроз.
- Bottom sheet подписки/отписки: иерархия громада/район/область со
  статусами A/P/N, длительность активной тревоги, радио выбора уровня
  подписки («Громада/Район/Область»), кнопка действия; секция истории тревог
  области: «Довготривалі» (≥24 ч), «Сьогодні», «Вчора» с карточками по
  `alert_type`.
- Диалог подписки по геолокации (Да/Нет/«Больше не спрашивать»).
- Тексты — украинская локаль (`values-uk`).

## 6. Push-уведомления и шина обновлений

### 6.1. Формат FCM-сообщения от сервера (фиксирован)

```json
{
  "token": "<fcm_token>",
  "notification": { "title": "<title_uk>", "body": "<body_uk>" },
  "data": {
    "subscription_id": "uuid",
    "event_id": "uuid | \"\"",
    "dispatch_kind": "start | end | level_changed",
    "alert_level": "red | yellow",
    "sent_at": "<kyiv timestamp>"
  },
  "android": { "priority": "high" }
}
```

Тексты сервер отдаёт уже отрендеренными на украинском. Виды диспатча:

| `dispatch_kind` | title | body |
|-----------------|-------|------|
| `start` (red) | `🔴 Червоний рівень тривоги!` | `<region> — прямуйте в укриття!` |
| `start` (yellow) | `🟡 Жовтий рівень тривоги!` | `<region> — прямуйте в укриття!` |
| `end` | `✅ Відбій тривоги` | `<region> — тривога скасована.` |
| `level_changed` (red→yellow) | `🟡 Зміна рівня тривоги` | отбой красного уровня |
| `level_changed` (yellow→red) | `🔴 Підвищення рівня тривоги!` | повышение уровня |

`<region>` выбирается сервером по `label_user` подписки (район/область/
община). Название региона **в data не дублируется** — для отображения брать
из notification-payload или сопоставлять `subscription_id` с локальным
кэшем пинов. `event_id` пустая строка для `level_changed`.

### 6.2. Обработка на клиенте

- `AlertFirebaseService : FirebaseMessagingService`:
  - `onNewToken` → сохранить → `ensureInstallationRegistered` →
    `updateFcmToken` (Bearer).
  - `onMessageReceived`: создать канал, title/body из notification-payload;
    `data["dispatch_kind"]` (`start`/`level_changed` на red → приоритетный
    цвет, иначе цвет отбоя); BigTextStyle, PRIORITY_HIGH, autoCancel, id =
    `currentTimeMillis % Int.MAX_VALUE`.
  - После показа — `AlertUpdateBus.notifyUpdate()`.
- **`AlertUpdateBus`** — `MutableSharedFlow` (buffer 4, DROP_OLDEST): пуш
  мгновенно дёргает оба менеджера слоёв (немедленный `fetchAndApplyStatuses`),
  не дожидаясь poll; при реальных изменениях — тост «Статуси тривог оновлено».
- **Каналы уведомлений** (важная ловушка Android): звук/вибрация нельзя менять
  у существующего канала, поэтому **ID канала кодирует настройки**:
  `alerts_ua_channel_{soundKey|custom_hash}_{_v1|_v0}`. Звуки: `emerging_1`
  (default, res/raw), `system`, `silent`, `custom` (URI через SAF, имя файла —
  через OpenableColumns). Вибрация — pattern `[0,300,200,300]`. При смене
  настроек старые каналы удаляются (версионированный cleanup, legacy-префиксы
  `app_notification_channel*`). На API <26 звук/вибрация — через builder.
- `NotificationSettingsManager` — SharedPreferences `AppPrefs`.

## 7. Локация и разрешения

- `LocationService`: `FusedLocationProviderClient.getCurrentLocation(
  PRIORITY_HIGH_ACCURACY, null).await()` (kotlinx-coroutines await), fallback
  `lastLocation`; null без ACCESS_FINE_LOCATION.
- Запрос разрешений через `ActivityResultContracts` из MainActivity; в
  onResume перечитывается статус (могли выдать через системные настройки).
- **Первый запуск**: если пинов нет и не «don't ask» — запрос геолокации →
  resolve-point → диалог подписки на свою общину.
- POST_NOTIFICATIONS (API 33+) запрашивается в MainActivity и повторно перед
  созданием подписки.
- Маркер локации обновляется на ON_RESUME и при mapPageReady (пассивно, без
  центрирования); кнопка локации центрирует.

## 8. Экраны (функционально, без оформления)

| Экран | Функциональность |
|-------|-----------------|
| Карта (главный) | см. раздел 5 |
| Настройки | звук уведомлений (4 варианта + кастомный через SAF), вибрация, статусы разрешений с переходом в системные настройки, смена сервера (api_base_url) |
| FAQ | bottom sheet, markdown-подобный рендер текста |
| Rate prompt | карточка оценки (Play Store, market:// → fallback https); условия: 5+ дней подряд, snooze 3 дня; force через intent-extra |

## 9. Офлайн и ошибки

- Без сети: карта рисует границы, маску, оккупированные территории из ассетов;
  статусов нет (lookup пуст). Пины подписок — из SharedPreferences, рисуются
  всегда.
- Все сетевые падения логируются тихо; пользователю — только тосты при
  ручном обновлении («Дані вже актуальні» / «Статуси тривог оновлено» /
  ошибка).

## 10. Ассеты и скрипты

- `app/src/main/assets/map/data/`: `oblast.geojson` (~186 КБ), `raion.geojson`
  (~400 КБ), `hromada.geojson` (~1.4 МБ), `ukraine-boundary.geojson` (~78 КБ,
  формат `{"feature":{...}}`), `occupied-territories.geojson` (~66 КБ),
  `layer-meta.json` (~56 КБ). GeoJSON-компактный, без пробелов (критично для
  строковой инъекции).
- `app/src/main/assets/map/icons/*.png`: air-raid, artillery-shelling,
  urban-fights, exclamation, kab-black/grey, missile-black/grey,
  shahed-light/dark, war-monitor.
- `scripts/generate-layer-meta.js` (node): из трёх geojson → layer-meta.json
  `{layer: {uid: {c:[lon,lat] (bbox-центр, округление 1e-6), t:title_uk,
  r:region_type}}}`; запускать после любого обновления геометрий.
- `scripts/optimize-icons.js` (sharp): ресайз иконок в webp по плотностям.

## 11. Критические правила и ловушки

1. **Геометрию НЕ парсить в объектный граф** — строковая инъекция статусов
   требует сырого GeoJSON; MapLibre парсит строку в C++-ядре.
2. **Race-guard `state_version`**: poll применяет только `> applied`, ручное
   обновление — `>=` (force).
3. **Циклы 304/no-change**: сервер обновляет кэш только при реальных
   изменениях; клиент доверяет `state_version`, не полному сравнению.
4. **Каналы уведомлений**: настройки звука кодируются в ID канала; менять
   звук у существующего канала нельзя — создавать новый и удалять старый.
5. **`status='P'`** — родитель частично активен: не заливать сам регион
   (сервер отдаёт lookup только по листьям, но клиент не должен
   агрегировать сам).
6. **Наследование Киева** — город берёт статус области при отсутствии
   собственного `A`.
7. **Тапы вне границы Украины** игнорируются (ray casting по boundary-ассету).
8. **Киевский bbox** в обработке тапа резолвится в фиксированный центр города.
9. **`app_version`/`app_build` в `/installations`** — брать из `BuildConfig`,
   не хардкодить (в исходной реализации захардкожено — ошибка, не повторять).
10. **MapLibre требует Vulkan** на некоторых устройствах — declare
    `uses-feature vulkan required=false`.
11. **WorkManager** — фиксировать современную версию явно (транзитивная
    старая падает на 16КБ-страницах).
12. **Polling паузится в фоне** (ON_STOP) и возобновляется на ON_START с
    порогом 10 сек.

## 12. Критерии приёмки

- [ ] Debug-сборка собирается без ключей подписи; release — только с ними.
- [ ] Карта стартует на bbox Украины; слои границ/маски/occupied рисуются
      без сети из ассетов.
- [ ] После получения `/map/bundle` заливаются только фичи с `status=='A'`,
      цвет по alert_type/alert_level; повторный bundle с тем же
      `state_version` игнорируется.
- [ ] FCM-push вызывает немедленное обновление слоёв через AlertUpdateBus.
- [ ] Тап → resolve-point → bottom sheet с иерархией и статусами → создание
      пина → пин виден на карте и в списке после перезапуска (офлайн-кэш).
- [ ] Уведомление с `dispatch_kind=start` приходит с приоритетным звуком;
      смена звука в настройках действует на следующие уведомления.
- [ ] `/installations` регистрируется один раз; `onNewToken` обновляет токен
      на сервере.
- [ ] Polling bundle 30 сек / threats 60 сек паузится в фоне.
- [ ] Угрозовые дуги пересчитываются по camera-idle; кластеризация
      работает; тап по угрозе с `message_text` открывает попап.
- [ ] Тап вне границы Украины и в bbox Киева ведут себя по спецификации.
- [ ] `generate-layer-meta.js` воспроизводит layer-meta.json из геометрий.
- [ ] Регистрация: `POST /installations` → сохранён `installation_token`;
      повторный запуск не создаёт новую установку (фолбэк по android_id);
      401 → перерегистрация.
- [ ] Подписка с `label_user="Район"` создаётся, пин виден, удаляется;
      тело/ответы соответствуют разделу 2.3.
- [ ] Пуш с `dispatch_kind=start` отображается с приоритетным каналом/звуком,
      по пушу слои карты обновляются через AlertUpdateBus.
- [ ] AdMob-баннер загружается (test/dev режим при необходимости), скрывается
      тогглом AdManager и в полноэкранном режиме.
