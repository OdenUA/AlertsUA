#!/bin/bash
# Восстановление полного бэкапа VPS (Alerts UA + Dtek + PoeNotif) на чистый Debian 12.
# Запуск: bash /root/full-backup/restore-full-vps.sh [--archive /path/to/vps-full-backup-<date>.tar.gz]
# Всё выполняется автоматически: пакеты, роли, БД (создаются скриптом), деревья,
# systemd, nginx, cron, health-checks. Скрипт идемпотентен и ДЕСТРУКТИВЕН для
# существующих БД alerts_ua / poe2notif и деревьев на целевой машине.

set -euo pipefail

ARCHIVE=""
for a in "$@"; do
    case "$a" in
        --archive) ;;
        --archive=*) ARCHIVE="${a#*=}" ;;
        *) [ -z "$ARCHIVE" ] && [[ "$a" == *.tar.gz ]] && ARCHIVE="$a" ;;
    esac
done
[ -n "$ARCHIVE" ] || ARCHIVE="$(ls -1t /root/full-backup/vps-full-backup-*.tar.gz 2>/dev/null | head -1 || true)"

log() { echo "[restore] $*"; }
fail() { echo "[restore][ERROR] $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || fail "archive not found (pass --archive /path/to/vps-full-backup-*.tar.gz)"
log "archive: ${ARCHIVE}"

WORK=/root/full-backup/restore-work
rm -rf "${WORK}"
mkdir -p "${WORK}"
log "extracting archive..."
tar -xzf "${ARCHIVE}" -C "${WORK}"
SRC="$(ls -d "${WORK}"/vps-full-backup-*)"
[ -d "${SRC}/postgres" ] || fail "invalid archive: no postgres/ section"
log "extracted to ${SRC}"
[ -f "${SRC}/MANIFEST.txt" ] && cat "${SRC}/MANIFEST.txt" | sed 's/^/[manifest] /'

# --- 1. Пакеты ---
if ! command -v psql >/dev/null 2>&1; then
    log "installing postgresql/postgis/redis/nginx..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y postgresql postgresql-15-postgis-3 redis-server nginx curl ca-certificates gnupg
else
    log "postgresql already present, skipping base packages"
fi

if ! node -v 2>/dev/null | grep -q '^v20\.'; then
    log "installing Node.js 20 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
log "node: $(node -v)"

systemctl enable --now postgresql redis-server >/dev/null 2>&1 || true
for i in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready -q || fail "postgresql did not become ready"

# --- 2. Роли и БД (автоматически) ---
log "restoring postgres roles..."
# stdin-перенаправление делает root: postgres не читает файлы из /root напрямую
runuser -u postgres -- psql -v ON_ERROR_STOP=1 < "${SRC}/postgres/roles.sql" >/dev/null

restore_db() { # db owner dump
    local db="$1" owner="$2" dump="$3"
    log "restoring database ${db} (owner ${owner})..."
    runuser -u postgres -- dropdb --if-exists "${db}"
    runuser -u postgres -- createdb -O "${owner}" "${db}"
    runuser -u postgres -- pg_restore --exit-on-error -d "${db}" < "${dump}"
}

restore_db alerts_ua alerts_ua_app "${SRC}/postgres/alerts_ua.dump"
restore_db poe2notif poe2notif "${SRC}/postgres/poe2notif.dump"
log "databases restored"

# --- 3. Пользователи ---
id -u alerts-ua >/dev/null 2>&1 || useradd -r -s /bin/bash -d /srv/alerts-ua alerts-ua
id -u poe2notif  >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/poe2notif poe2notif

# --- 4. Деревья ---
log "restoring service trees..."
mkdir -p /srv/alerts-ua
cp -a "${SRC}/srv-alerts-ua/." /srv/alerts-ua/
rm -rf /root/dtek-scraper
cp -a "${SRC}/dtek-scraper" /root/dtek-scraper
rm -rf /opt/poe2notif
cp -a "${SRC}/poe2notif" /opt/poe2notif

chown -R alerts-ua:alerts-ua /srv/alerts-ua
chown -R poe2notif:poe2notif /opt/poe2notif
chmod +x /opt/poe2notif/deno
log "trees restored"

# --- 5. systemd ---
log "installing systemd units..."
cp -a "${SRC}/systemd/." /etc/systemd/system/
systemctl daemon-reload
for t in "${SRC}"/systemd/*.timer; do
    [ -e "$t" ] && systemctl enable --now "$(basename "$t")" >/dev/null 2>&1 || true
done
for s in alerts-ua-api dtek-api poe2notif; do
    systemctl enable --now "$s"
done

# --- 6. nginx ---
log "restoring nginx config..."
cp -a "${SRC}/nginx/sites-available/." /etc/nginx/sites-available/
cp -a "${SRC}/nginx/sites-enabled/." /etc/nginx/sites-enabled/
systemctl enable nginx >/dev/null 2>&1 || true
nginx -t
systemctl reload nginx || systemctl restart nginx

# --- 7. cron и misc ---
if [ -f "${SRC}/misc/root.crontab" ]; then
    crontab "${SRC}/misc/root.crontab"
    log "crontab installed"
fi
[ -f "${SRC}/misc/fetch-occupied.sh" ] && cp -a "${SRC}/misc/fetch-occupied.sh" /usr/local/bin/ && chmod +x /usr/local/bin/fetch-occupied.sh

# Redis-кэш намеренно НЕ восстанавливается (регенерируется воркерами/API).

# --- 8. Health-checks ---
echo ""
log "waiting for services to come up..."
sleep 5
FAILED=0
check() { # name command...
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "[PASS] ${name}"; else echo "[FAIL] ${name}"; FAILED=1; fi
}

check "alerts-ua-api active"    systemctl is-active --quiet alerts-ua-api
check "dtek-api active"         systemctl is-active --quiet dtek-api
check "poe2notif active"        systemctl is-active --quiet poe2notif
check "alerts API :3100"        curl -sf -m 10 http://127.0.0.1:3100/api/v1/system/health
check "alerts API via nginx :80" curl -sf -m 10 http://127.0.0.1/api/v1/map/regions
check "dtek API :8080"          bash -c "curl -sf -m 5 -o /dev/null http://127.0.0.1:8080/ || curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ | grep -qE '^[0-9]{3}$'"

TIMER_COUNT=$(systemctl list-timers --all --no-legend 2>/dev/null | grep -c 'alerts-ua-.*\.timer' || true)
echo "[INFO] alerts-ua timers scheduled: ${TIMER_COUNT}"
[ "${TIMER_COUNT}" -ge 7 ] || { echo "[FAIL] expected >=7 alerts-ua timers"; FAILED=1; }

echo ""
if [ "${FAILED}" -eq 0 ]; then
    log "RESTORE COMPLETED SUCCESSFULLY"
else
    log "RESTORE FINISHED WITH FAILURES (see [FAIL] above)"
fi
exit "${FAILED}"
