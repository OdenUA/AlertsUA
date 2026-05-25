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

# Создаем директорию для данных если не существует
mkdir -p "${DATA_DIR}"

# Логируем начало
echo "========================================" >> "${LOG_FILE}"
echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting occupied territories update" >> "${LOG_FILE}"

# Переходим в директорию приложения
cd "${APP_DIR}" || {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR: Cannot cd to ${APP_DIR}" >> "${LOG_FILE}"
    exit 1
}

# Загружаем данные с GitHub
GITHUB_URL="https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data"
TODAY=$(date +%Y%m%d)
FILE_NAME="deepstatemap_data_${TODAY}.geojson"

echo "Fetching: ${GITHUB_URL}/${FILE_NAME}" >> "${LOG_FILE}"

HTTP_CODE=$(curl -s -o "${DATA_DIR}/occupied-territories.geojson.tmp" -w "%{http_code}" "${GITHUB_URL}/${FILE_NAME}" 2>> "${LOG_FILE}")

if [ "${HTTP_CODE}" = "200" ]; then
    mv "${DATA_DIR}/occupied-territories.geojson.tmp" "${DATA_DIR}/occupied-territories.geojson"

    # Проверяем валидность JSON
    if jq empty "${DATA_DIR}/occupied-territories.geojson" 2>/dev/null; then
        FEATURES=$(jq '.features | length' "${DATA_DIR}/occupied-territories.geojson")
        echo "$(date '+%Y-%m-%d %H:%M:%S') - SUCCESS: Loaded ${FEATURES} features" >> "${LOG_FILE}"

        # Перезапускаем API для сброса кеша
        systemctl reload-or-restart alerts-ua-api.service 2>> "${LOG_FILE}"
        echo "$(date '+%Y-%m-%d %H:%M:%S') - API service restarted" >> "${LOG_FILE}"
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR: Invalid JSON" >> "${LOG_FILE}"
        rm -f "${DATA_DIR}/occupied-territories.geojson.tmp"
    fi
else
    # Пробуем вчерашний файл
    YESTERDAY=$(date -d "yesterday" +%Y%m%d)
    FILE_NAME_YESTERDAY="deepstatemap_data_${YESTERDAY}.geojson"

    echo "$(date '+%Y-%m-%d %H:%M:%S') - Today's file not found (${HTTP_CODE}), trying yesterday: ${FILE_NAME_YESTERDAY}" >> "${LOG_FILE}"

    HTTP_CODE=$(curl -s -o "${DATA_DIR}/occupied-territories.geojson.tmp" -w "%{http_code}" "${GITHUB_URL}/${FILE_NAME_YESTERDAY}" 2>> "${LOG_FILE}")

    if [ "${HTTP_CODE}" = "200" ]; then
        mv "${DATA_DIR}/occupied-territories.geojson.tmp" "${DATA_DIR}/occupied-territories.geojson"

        if jq empty "${DATA_DIR}/occupied-territories.geojson" 2>/dev/null; then
            FEATURES=$(jq '.features | length' "${DATA_DIR}/occupied-territories.geojson")
            echo "$(date '+%Y-%m-%d %H:%M:%S') - SUCCESS: Loaded yesterday's data, ${FEATURES} features" >> "${LOG_FILE}"

            systemctl reload-or-restart alerts-ua-api.service 2>> "${LOG_FILE}"
            echo "$(date '+%Y-%m-%d %H:%M:%S') - API service restarted" >> "${LOG_FILE}"
        else
            echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR: Invalid JSON in yesterday's file" >> "${LOG_FILE}"
            rm -f "${DATA_DIR}/occupied-territories.geojson.tmp"
        fi
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR: Failed to fetch yesterday's file (${HTTP_CODE})" >> "${LOG_FILE}"
        rm -f "${DATA_DIR}/occupied-territories.geojson.tmp"
    fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') - Update completed" >> "${LOG_FILE}"

# Храним логи только последние 30 дней
find /var/log/alerts-ua -name "fetch-occupied.log*" -mtime +30 -delete 2>/dev/null || true

exit 0
