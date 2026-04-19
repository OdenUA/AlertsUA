#!/usr/bin/env bash
set -euo pipefail

RELEASE_DIR="/srv/alerts-ua/app/releases/${1:-manual-$(date +%Y%m%d%H%M%S)}"

install -d -o alerts-ua -g alerts-ua "${RELEASE_DIR}"
install -d -o alerts-ua -g alerts-ua /srv/alerts-ua/app/current

echo "release_dir=${RELEASE_DIR}"