#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f /srv/alerts-ua/env/.env.api ]]; then
  echo "env file /srv/alerts-ua/env/.env.api not found" >&2
  exit 1
fi

set -a
source /srv/alerts-ua/env/.env.api
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

psql "${DATABASE_URL}"
