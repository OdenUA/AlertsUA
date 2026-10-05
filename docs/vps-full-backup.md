# Повний бэкап VPS (Alerts UA + Dtek + PoeNotif)

Один PowerShell-оркестратор `vps-backup.ps1` в корне репозитория управляет полным
бэкапом всех трёх сервисов и развёртыванием его на другой VPS.

## Что входит в бэкап

| Секция | Содержимое |
|---|---|
| `postgres/` | `alerts_ua.dump`, `poe2notif.dump` (pg_dump custom format), `roles.sql` (роли + пароли) |
| `redis/` | `dump.rdb` (кэш; восстановление не обязательно — регенерируется) |
| `srv-alerts-ua/` | `/srv/alerts-ua`: `app/` (releases + symlink `current`), `env/`, `data/` (geo/imports), `runtime/node/`, `systemd/`, `scripts/`, `secrets.env` |
| `dtek-scraper/` | `/root/dtek-scraper` целиком (код + `node_modules` + `vps-env.sh` + ключи Firebase) |
| `poe2notif/` | `/opt/poe2notif` целиком (app + deno-бинарник + кэш + `secrets.env`) |
| `systemd/` | Юниты `alerts-ua-*.{service,timer}`, `dtek-api.service`, `poe2notif.service` |
| `nginx/` | `sites-available/` + `sites-enabled/` |
| `misc/` | `root.crontab`, `fetch-occupied.sh` |
| `MANIFEST.txt` | Версии node/deno/psql, kernel, дата |

Архив **не шифруется** и содержит все секреты — хранить только в `backups/` (в gitignore)
и на доверенных машинах.

## Создание бэкапа

```powershell
.\vps-backup.ps1 -Action Backup
# или явно:
.\vps-backup.ps1 -Action Backup -SourceHost root@173.242.53.129 -SourceKey .\VPS-54592
```

Источник берётся из `VPS_SSH_USER` / `VPS_SSH_KEY` в `secrets.env`, если параметры не заданы.
Скрипт: загружает `infra/vps/scripts/backup-full-vps.sh` на VPS, запускает его,
скачивает `vps-full-backup-<date>.tar.gz` в `backups\`, проверяет sha256.
Копия архива остаётся на VPS в `/root/full-backup/`.

При успешном создании нового архива **предыдущие архивы удаляются автоматически**
и на VPS, и локально в `backups\` — хранится только последняя копия.

## Развёртывание на новый VPS

Требования к целевому хосту: **чистый Debian 12**, доступ root по SSH, минимум ~6 ГБ диска.

```powershell
.\vps-backup.ps1 -Action Restore -TargetHost root@NEW_IP -TargetKey .\new-vps-key
# конкретный архив (иначе — самый свежий в backups\):
.\vps-backup.ps1 -Action Restore -TargetHost root@NEW_IP -TargetKey .\new-vps-key -Archive backups\vps-full-backup-20260926-230000.tar.gz
# сначала посмотреть, что будет сделано:
.\vps-backup.ps1 -Action Restore -TargetHost root@NEW_IP -DryRun
```

Restore-скрипт (`infra/vps/scripts/restore-full-vps.sh`) делает всё автоматически:

1. Устанавливает пакеты: PostgreSQL 15 + PostGIS 3, Redis, nginx, Node.js 20 (NodeSource, для Dtek).
2. Восстанавливает роли PostgreSQL из `roles.sql`, **создаёт БД** `alerts_ua`
   (owner `alerts_ua_app`) и `poe2notif` (owner `poe2notif`), наполняет их `pg_restore`.
3. Создаёт пользователей `alerts-ua` и `poe2notif`, восстанавливает деревья
   (`/srv/alerts-ua`, `/root/dtek-scraper`, `/opt/poe2notif`), права и symlink `current`.
4. Ставит systemd-юниты, включает и запускает сервисы и таймеры.
5. Восстанавливает nginx-конфиги (`nginx -t` + reload) и crontab.
6. Health-checks: статус трёх сервисов, `curl` Alerts API :3100 и через nginx :80,
   Dtek :8080, наличие таймеров. Код выхода ненулевой при любом провале.

Скрипт идемпотентен: перезапуск безопасен, но **деструктивен** — пересоздаёт БД
и перезаписывает деревья на целевой машине.

## Пост-действия после restore

- **IP-адрес**: Android-клиенты и код бэкенда ссылаются на IP. Обновить:
  - `infra/vps/nginx/alerts-public-ip.conf` (`server_name` / IP) — или оставить порт-прокси как есть;
  - `buildConfigField` API URL в `android-app/app/build.gradle.kts` (`http://<IP>/api/v1`) и перевыпустить APK;
  - cron-строки и env, если в них зашит старый IP.
- **Supabase (Dtek)**: данные Dtek живут во внешнем Supabase — бэкап содержит только
  учётные данные доступа (`vps-env.sh`). Если Supabase тот же — ничего делать не нужно.
- **Порты на новом VPS**: 80 (nginx), 3100 (Alerts API, внутренний), 8080/1883 (Dtek).
  Убедиться, что фаервол/провайдер пропускают их.
- **Проверка**: `systemctl status alerts-ua-api dtek-api poe2notif`,
  `curl http://<NEW_IP>/api/v1/map/regions`.

## Что НЕ входит / ограничения

- Исторические Telegram-сессии, локальный кэш Redis — регенерируемые, Redis не восстанавливается.
- TLS/сертификаты не используются (доступ по IP по порту 80).
- Если на целевом VPS уже что-то работает на портах 80/8080/1883 — будет конфликт, нужно освободить порты заранее.
