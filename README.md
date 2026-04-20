# Alerts UA

Початковий monorepo для Android-застосунку мапи повiтряних тривог України.

## Структура

- `backend` — NestJS backend для VPS.
- `android-app` — Kotlin Android-клiєнт.
- `infra` — шаблони systemd та reverse proxy.
- `supabase` — cold-path SQL мiграцiї.
- `docs` — runbook i нотатки по розгортанню.

## Поточний стан

- Зафiксовано локальний довiдник `alerts.in.ua _ Райони, області, громади.xlsx` як primary import source.
- Проведено read-only preflight VPS.
- Виявлено чинний сервiс `dtek-api.service`, що працює в `/root/dtek-scraper` вiд `/usr/bin/node` та слухає порти `8080` i `1883`.
- Для нового проєкту закладена iзоляцiя в `/srv/alerts-ua` з окремим runtime, БД, systemd units i портом.
- На VPS вже працює `alerts-ua-api.service` на `127.0.0.1:3100`.
- У PostgreSQL створено БД `alerts_ua` з PostGIS i застосовано базову hot-schema.
- Перший iмпорт XLSX завершився успiшно: `1622` записiв у `region_catalog`.

## Android Debug

- Лог `com.google.android.apps.wellbeing` / `ResourcesManager failed to open APK .../base.apk` пiсля `adb install -r` є системним шумом емульованого Android через застарiлий шлях до попереднього APK, а не крешем `com.alertsua.app`.
- Для перевiрки реальних помилок застосунку використовуйте `logcat-app.bat`: скрипт фiльтрує `com.alertsua.app`, `AndroidRuntime` i `FATAL EXCEPTION`.

## Наступнi кроки

1. Встановити залежностi backend i запустити локальний dev server.
2. Добудувати importer так, щоб вiн збагачував `oblast_uid` для районiв i громад з надiйного джерела, а не з припущення по порядку рядкiв.
3. Реалiзувати polling worker для alerts.in.ua та генерацiю `started/ended/state_changed` подiй.
4. Добудувати push dispatcher, геометричний resolver i Supabase sync.
5. Дотягнути Android app до першого компiльованого MVP.
