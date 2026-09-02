#!/bin/bash
#
# Скрипт для ежедневного обновления данных об оккупированных территориях
# Запускается через systemd timer
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/srv/alerts-ua/app/current"
DATA_DIR="${APP_DIR}/data"
LOG_FILE="/var/log/alerts-ua/fetch-occupied.log"
TMP_FILE=""

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "${LOG_FILE}"
}

cleanup_tmp() {
    if [ -n "${TMP_FILE}" ] && [ -f "${TMP_FILE}" ]; then
        rm -f "${TMP_FILE}"
    fi
}
trap cleanup_tmp EXIT

# Валидация GeoJSON через node (jq на VPS не установлен)
validate_geojson() {
    /usr/bin/node -e '
        const fs = require("fs");
        try {
            const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            if (data.type === "FeatureCollection" && Array.isArray(data.features) && data.features.length > 0) {
                console.log(data.features.length);
                process.exit(0);
            }
        } catch (e) { }
        process.exit(1);
    ' "$1"
}

# Валидация и атомарная установка: рабочий файл заменяется ТОЛЬКО
# валидным непустым GeoJSON. Иначе прежний файл остаётся нетронутым.
install_if_valid() {
    local source_desc="$1"

    local features
    if ! features=$(validate_geojson "${TMP_FILE}"); then
        log "ERROR: Invalid or empty GeoJSON (${source_desc}), keeping previous file"
        return 1
    fi

    mv "${TMP_FILE}" "${DATA_DIR}/occupied-territories.geojson"
    TMP_FILE=""

    log "SUCCESS: Loaded ${features} features (${source_desc})"

    # Перезапускаем API для сброса кеша
    systemctl reload-or-restart alerts-ua-api.service 2>> "${LOG_FILE}"
    log "API service restarted"
    return 0
}

fetch_to_tmp() {
    local file_name="$1"
    TMP_FILE="${DATA_DIR}/occupied-territories.geojson.tmp"
    curl -s -o "${TMP_FILE}" -w "%{http_code}" "${GITHUB_URL}/${file_name}" 2>> "${LOG_FILE}"
}

# Создаем директорию для данных если не существует
mkdir -p "${DATA_DIR}"

# Логируем начало
echo "========================================" >> "${LOG_FILE}"
log "Starting occupied territories update"

# Переходим в директорию приложения
cd "${APP_DIR}" || {
    log "ERROR: Cannot cd to ${APP_DIR}"
    exit 1
}

# Загружаем данные с GitHub
GITHUB_URL="https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data"
TODAY=$(date +%Y%m%d)
FILE_NAME="deepstatemap_data_${TODAY}.geojson"

log "Fetching: ${GITHUB_URL}/${FILE_NAME}"

HTTP_CODE=$(fetch_to_tmp "${FILE_NAME}")

if [ "${HTTP_CODE}" = "200" ] && install_if_valid "today"; then
    :
else
    if [ "${HTTP_CODE}" = "200" ]; then
        log "Today's file failed validation, trying yesterday"
    else
        log "Today's file not found (${HTTP_CODE}), trying yesterday"
    fi

    YESTERDAY=$(date -d "yesterday" +%Y%m%d)
    FILE_NAME_YESTERDAY="deepstatemap_data_${YESTERDAY}.geojson"

    log "Fetching: ${GITHUB_URL}/${FILE_NAME_YESTERDAY}"

    HTTP_CODE=$(fetch_to_tmp "${FILE_NAME_YESTERDAY}")

    if [ "${HTTP_CODE}" = "200" ]; then
        install_if_valid "yesterday" || true
    else
        log "ERROR: Failed to fetch yesterday's file (${HTTP_CODE}), keeping previous file"
    fi
fi

log "Update completed"

# Храним логи только последние 30 дней
find /var/log/alerts-ua -name "fetch-occupied.log*" -mtime +30 -delete 2>/dev/null || true

exit 0
