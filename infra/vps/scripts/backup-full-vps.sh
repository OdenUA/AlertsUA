#!/bin/bash
# Повний бэкап VPS: Alerts UA + Dtek + PoeNotif.
# Запуск: bash /root/full-backup/backup-full-vps.sh
# Результат: /root/full-backup/vps-full-backup-<date>.tar.gz (+ sha256).
# В архиве — RESTORE-INSTRUCTIONS.txt (полная инструкция по развёртыванию
# на чистой машине) и restore-full-vps.sh (автовосстановление).
# Не останавливает сервисы. Требует root.

set -euo pipefail

BACKUP_ROOT="/root/full-backup"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE_NAME="vps-full-backup-${STAMP}"
STAGE="${BACKUP_ROOT}/staging/${STAGE_NAME}"
ARCHIVE="${BACKUP_ROOT}/${STAGE_NAME}.tar.gz"

log() { echo "[backup] $*"; }
fail() { echo "[backup][ERROR] $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root"
mkdir -p "${BACKUP_ROOT}/staging" "${STAGE}/postgres" "${STAGE}/redis" \
         "${STAGE}/srv-alerts-ua" "${STAGE}/systemd" "${STAGE}/nginx" "${STAGE}/misc"

# Деревья копируем хардлинками (мгновенно, без двойного расхода диска);
# если src и staging на разных ФС — fallback на обычное копирование.
linktree() {
    cp -al "$1" "$2" 2>/dev/null || cp -a "$1" "$2"
}

# --- 0. Проверка свободного места (архив ~2-3 ГБ) ---
FREE_GB=$(df -BG --output=avail "${BACKUP_ROOT}" | tail -1 | tr -dc '0-9')
[ "${FREE_GB:-0}" -ge 5 ] || fail "less than 5GB free on ${BACKUP_ROOT} (avail: ${FREE_GB}G)"
log "free space: ${FREE_GB}G"

# --- 1. PostgreSQL ---
log "dumping PostgreSQL databases..."
# Перенаправление в файл делает root-шелл: пользователь postgres только пишет в stdout.
# --lock-wait-timeout: иначе pg_dump ждёт чужой лок вечно (lock_timeout=0) и весь
# бэкап висит до убийства ssh-сессии снаружи (было 16.10 на poe2notif).
runuser -u postgres -- pg_dump -Fc --lock-wait-timeout=120s alerts_ua > "${STAGE}/postgres/alerts_ua.dump"
runuser -u postgres -- pg_dump -Fc --lock-wait-timeout=120s poe2notif > "${STAGE}/postgres/poe2notif.dump"
runuser -u postgres -- pg_dumpall --lock-wait-timeout=120s --roles-only > "${STAGE}/postgres/roles.sql"
log "postgres dumps done"

# --- 2. Redis (кэш регенерируемый, но копия дешёвая) ---
if [ -f /var/lib/redis/dump.rdb ]; then
    cp -a /var/lib/redis/dump.rdb "${STAGE}/redis/dump.rdb"
    log "redis dump.rdb copied"
fi

# --- 3. Деревья сервисов ---
log "snapshotting service trees (hardlinks)..."

# Alerts UA: только нужные поддеревья, без мусора (backend*, dist*, src-temp и т.п.)
for d in app env data runtime systemd scripts; do
    [ -e "/srv/alerts-ua/${d}" ] && linktree "/srv/alerts-ua/${d}" "${STAGE}/srv-alerts-ua/${d}"
done
[ -f /srv/alerts-ua/secrets.env ] && cp -a /srv/alerts-ua/secrets.env "${STAGE}/srv-alerts-ua/secrets.env"

# Dtek: репозитория нет — копия целиком, включая node_modules
linktree /root/dtek-scraper "${STAGE}/dtek-scraper"

# PoeNotif: app + deno-бинарник + кэш + secrets
linktree /opt/poe2notif "${STAGE}/poe2notif"

# --- 4. systemd-юниты трёх сервисов ---
for u in /etc/systemd/system/alerts-ua-*.service /etc/systemd/system/alerts-ua-*.timer \
         /etc/systemd/system/dtek-api.service /etc/systemd/system/poe2notif.service; do
    [ -e "$u" ] && cp -a "$u" "${STAGE}/systemd/"
done

# --- 5. nginx ---
linktree /etc/nginx/sites-available "${STAGE}/nginx/sites-available"
linktree /etc/nginx/sites-enabled "${STAGE}/nginx/sites-enabled"

# --- 6. misc: cron и вспомогательные скрипты ---
crontab -l > "${STAGE}/misc/root.crontab" 2>/dev/null || true
[ -f /usr/local/bin/fetch-occupied.sh ] && cp -a /usr/local/bin/fetch-occupied.sh "${STAGE}/misc/"

# --- 7. Манифест ---
{
    echo "backup_stamp=${STAMP}"
    echo "host=$(hostname)"
    echo "kernel=$(uname -r)"
    echo "node_system=$(node -v 2>/dev/null || echo none)"
    echo "node_alerts=$(/srv/alerts-ua/runtime/node/bin/node -v 2>/dev/null || echo none)"
    echo "deno=$(/opt/poe2notif/deno --version 2>/dev/null | head -1 || echo none)"
    echo "psql=$(psql --version 2>/dev/null || echo none)"
} > "${STAGE}/MANIFEST.txt"

# --- 7b. Скрипт и инструкция по восстановлению — чтобы архив был самодостаточным ---
# restore-скрипт сюда догружает vps-backup.ps1 (best-effort); без него в архиве
# останется только инструкция со ссылкой на репозиторий.
[ -f "${BACKUP_ROOT}/restore-full-vps.sh" ] && cp -a "${BACKUP_ROOT}/restore-full-vps.sh" "${STAGE}/"

{
    echo "ПОВНЕ ВІДНОВЛЕННЯ VPS З ЦЬОГО АРХІВУ (Alerts UA + Dtek + PoeNotif)"
    echo "================================================================"
    echo "Архів:     $(basename "${ARCHIVE}")"
    echo "Створено:  $(date -Is) на хості $(hostname)"
    echo ""
    cat <<'INSTR_EOF'
1. ЩО ЦЕ
   Повний бэкап VPS трьох сервісів: Alerts UA (NestJS API + воркери),
   Dtek (dtek-api :8080) і PoeNotif. Бази PostgreSQL знімалися онлайн
   (pg_dump, без зупинки сервісів). Архів НЕ шифрується — всередині
   відкриті секрети (env-файли, ключі, паролі БД). Зберігати тільки
   на довірених машинах.

2. СКЛАД АРХІВУ (папка vps-full-backup-<дата>/)
   postgres/alerts_ua.dump  — база alerts_ua (pg_dump -Fc, owner alerts_ua_app)
   postgres/poe2notif.dump  — база poe2notif (pg_dump -Fc)
   postgres/roles.sql       — ролі PostgreSQL з паролями (pg_dumpall --roles-only)
   redis/dump.rdb           — слепок Redis (кеш; відновлювати не обов'язково)
   srv-alerts-ua/           — /srv/alerts-ua: app/releases + symlink current,
                              env/, data/, runtime/node/, systemd/, scripts/,
                              secrets.env
   dtek-scraper/            — /root/dtek-scraper (код + node_modules + vps-env.sh)
   poe2notif/               — /opt/poe2notif (app + deno-бінарник + кеш + secrets)
   systemd/                 — юніти alerts-ua-*.service/.timer, dtek-api, poe2notif
   nginx/                   — sites-available/ + sites-enabled/
   misc/root.crontab        — crontab root
   misc/fetch-occupied.sh   — за наявності
   MANIFEST.txt             — версії node/deno/psql/kernel
   restore-full-vps.sh      — скрипт автоматичного відновлення (див. п.4)
   RESTORE-INSTRUCTIONS.txt — цей файл

3. ВИМОГИ ДО ЦІЛЬОВОГО ХОСТУ
   - Чистий Debian 12 (або сумісний), root по SSH
   - ~6+ ГБ вільного диска (архів ~1.3 ГБ + розпаковані дані)
   - Порти 80 (nginx), 3100 (Alerts API, внутрішній), 8080 і 1883 (Dtek) вільні
   - SSH-ключ до цільового хоста з локальної машини

4. ВАРІАНТ А — АВТОМАТИЧНЕ ВІДНОВЛЕННЯ (рекомендовано)
   restore-full-vps.sh вже всередині архіву.
   1) Залий архів на новий сервер:
        scp vps-full-backup-<дата>.tar.gz root@NEW_IP:/root/full-backup/
   2) Дістань скрипт з архіву (або візьми з репозиторію:
      infra/vps/scripts/restore-full-vps.sh):
        ssh root@NEW_IP 'cd /root/full-backup && mkdir -p x && tar -xzf vps-full-backup-<дата>.tar.gz -C x && cp x/vps-full-backup-*/restore-full-vps.sh .'
   3) Запусти:
        ssh root@NEW_IP 'bash /root/full-backup/restore-full-vps.sh --archive /root/full-backup/vps-full-backup-<дата>.tar.gz'
   Скрипт автоматично: встановить PostgreSQL 15 + PostGIS 3, Redis, nginx,
   Node.js 20 (NodeSource); відновить ролі, створить БД alerts_ua
   (owner alerts_ua_app) і poe2notif, наповнить pg_restore; створить
   користувачів alerts-ua/poe2notif; розкладе дерева з правами; поставить
   systemd-юніти й увімкне сервіси+таймери; відновить nginx (nginx -t + reload)
   і crontab; проганяє health-checkи з кодом виходу.
   УВАГА: скрипт ДЕСТРУКТИВНИЙ — DROP DATABASE alerts_ua/poe2notif і повний
   перезапис дерев на цільовій машині. Запускати тільки на чистому/сервері,
   який можна затирати.

5. ВАРІАНТ Б — ВРУЧНУ (якщо автоматика недоступна)
   Розпакувати:  mkdir -p /root/full-backup && tar -C /root/full-backup -xzf vps-full-backup-<дата>.tar.gz
   PostgreSQL:
        runuser -u postgres -- psql -v ON_ERROR_STOP=1 < STAGE/postgres/roles.sql
        runuser -u postgres -- dropdb --if-exists alerts_ua
        runuser -u postgres -- createdb -O alerts_ua_app alerts_ua
        runuser -u postgres -- pg_restore --exit-on-error -d alerts_ua < STAGE/postgres/alerts_ua.dump
     (те саме для poe2notif, owner — poe2notif)
   Дерева:
        mkdir -p /srv/alerts-ua
        cp -a STAGE/srv-alerts-ua/. /srv/alerts-ua/
        rm -rf /root/dtek-scraper && cp -a STAGE/dtek-scraper /root/dtek-scraper
        rm -rf /opt/poe2notif   && cp -a STAGE/poe2notif /opt/poe2notif
        chown -R alerts-ua:alerts-ua /srv/alerts-ua
        chown -R poe2notif:poe2notif /opt/poe2notif
   systemd:  cp -a STAGE/systemd/. /etc/systemd/system/ && systemctl daemon-reload
             systemctl enable --now alerts-ua-api dtek-api poe2notif
             systemctl enable --now alerts-ua-*.timer
   nginx:    cp -a STAGE/nginx/sites-available/. /etc/nginx/sites-available/
             cp -a STAGE/nginx/sites-enabled/. /etc/nginx/sites-enabled/
             nginx -t && systemctl reload nginx
   cron:     crontab STAGE/misc/root.crontab
   (STAGE = /root/full-backup/vps-full-backup-<дата>)

6. ПІСЛЯ ВІДНОВЛЕННЯ
   - Якщо змінився IP сервера: онови nginx-конфіги (server_name/IP),
     buildConfigField API URL у android-app/app/build.gradle.kts і перевипусти
     APK; перевір cron-рядки й env на згадки старого IP.
   - Dtek живе у зовнішньому Supabase — у архіві тільки облікові дані
     (dtek-scraper/vps-env.sh). Якщо Supabase той самий — нічого робити не треба.
   - Redis-кеш навмисно НЕ відновлюється — регенерується воркерами/API.
   - Перевірка:
        systemctl status alerts-ua-api dtek-api poe2notif
        curl -sf http://127.0.0.1/api/v1/map/regions
        systemctl list-timers | grep alerts-ua
INSTR_EOF
} > "${STAGE}/RESTORE-INSTRUCTIONS.txt"

# --- 8. Упаковка ---
log "packing archive (may take a few minutes)..."
tar -C "${BACKUP_ROOT}/staging" -czf "${ARCHIVE}" "${STAGE_NAME}"
rm -rf "${BACKUP_ROOT}/staging"

SHA=$(sha256sum "${ARCHIVE}" | awk '{print $1}')
SIZE=$(du -h "${ARCHIVE}" | awk '{print $1}')

# --- 9. Удаление предыдущих архивов (текущий уже успешно создан) ---
log "removing previous archives on VPS..."
for old in "${BACKUP_ROOT}"/vps-full-backup-*.tar.gz; do
    [ -e "$old" ] || continue
    [ "$old" = "${ARCHIVE}" ] && continue
    log "deleting old archive: ${old}"
    rm -f "$old"
done
# заодно чистим staging-остатки от прерванных прогонов
rm -rf "${BACKUP_ROOT}/staging"

echo ""
log "DONE"
echo "ARCHIVE_PATH=${ARCHIVE}"
echo "ARCHIVE_SIZE=${SIZE}"
echo "ARCHIVE_SHA256=${SHA}"
