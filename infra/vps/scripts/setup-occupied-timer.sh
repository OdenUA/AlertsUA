#!/bin/bash
#
# Скрипт для установки systemd timer для обновления оккупированных территорий
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[*] Installing occupied territories fetch timer..."

# Копируем скрипт
mkdir -p /srv/alerts-ua/infra/scripts
cp "${SCRIPT_DIR}/fetch-occupied-territories.sh" /srv/alerts-ua/infra/scripts/
chmod +x /srv/alerts-ua/infra/scripts/fetch-occupied-territories.sh

# Устанавливаем systemd unit и timer (лежат рядом с этим скриптом)
cp "${SCRIPT_DIR}/alerts-ua-fetch-occupied.service" /etc/systemd/system/
cp "${SCRIPT_DIR}/alerts-ua-fetch-occupied.timer" /etc/systemd/system/

# Перезагружаем systemd
systemctl daemon-reload

# Включаем и запускаем timer
systemctl enable alerts-ua-fetch-occupied.timer
systemctl start alerts-ua-fetch-occupied.timer

echo "[OK] Occupied territories timer installed and enabled"
echo "    Check status: systemctl status alerts-ua-fetch-occupied.timer"
echo "    Check logs: journalctl -u alerts-ua-fetch-occupied.service -f"
