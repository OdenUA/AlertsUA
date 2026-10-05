#!/bin/bash
# Повний бэкап VPS: Alerts UA + Dtek + PoeNotif.
# Запуск: bash /root/full-backup/backup-full-vps.sh
# Результат: /root/full-backup/vps-full-backup-<date>.tar.gz (+ sha256).
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
# Перенаправление в файл делает root-шелл: пользователь postgres только пишет в stdout
runuser -u postgres -- pg_dump -Fc alerts_ua > "${STAGE}/postgres/alerts_ua.dump"
runuser -u postgres -- pg_dump -Fc poe2notif > "${STAGE}/postgres/poe2notif.dump"
runuser -u postgres -- pg_dumpall --roles-only > "${STAGE}/postgres/roles.sql"
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
