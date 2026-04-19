#!/usr/bin/env bash
set -euo pipefail

DB_NAME="alerts_ua"
DB_USER="alerts_ua_app"
DB_PASSWORD="$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 32)"

if ! id alerts-ua >/dev/null 2>&1; then
  echo "alerts-ua user does not exist" >&2
  exit 1
fi

if ! systemctl is-active --quiet postgresql; then
  echo "postgresql service is not active" >&2
  exit 1
fi

if ! systemctl is-active --quiet redis-server; then
  echo "redis-server service is not active" >&2
  exit 1
fi

if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" | grep -q 1; then
  runuser -u postgres -- psql -c "ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
else
  runuser -u postgres -- psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';"
fi

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  runuser -u postgres -- createdb -O "${DB_USER}" "${DB_NAME}"
fi

runuser -u postgres -- psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"

cat > /srv/alerts-ua/env/.env.api <<EOF
APP_ENV=production
PORT=3100
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
REDIS_URL=redis://127.0.0.1:6379/3
REDIS_KEY_PREFIX=alerts-ua:
SUPABASE_URL=__SET_ME__
SUPABASE_PUBLISHABLE_KEY=__SET_ME__
SUPABASE_SECRET_KEY=__SET_ME__
SUPABASE_SERVICE_KEY=__SET_ME__
ALERTS_IN_UA_TOKEN=__SET_ME__
FIREBASE_SERVICE_ACCOUNT_PATH=/srv/alerts-ua/env/firebase-service-account.json
EOF

cat > /srv/alerts-ua/env/.env.worker <<EOF
APP_ENV=production
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
REDIS_URL=redis://127.0.0.1:6379/3
REDIS_KEY_PREFIX=alerts-ua:
SUPABASE_URL=__SET_ME__
SUPABASE_PUBLISHABLE_KEY=__SET_ME__
SUPABASE_SECRET_KEY=__SET_ME__
SUPABASE_SERVICE_KEY=__SET_ME__
ALERTS_IN_UA_TOKEN=__SET_ME__
FIREBASE_SERVICE_ACCOUNT_PATH=/srv/alerts-ua/env/firebase-service-account.json
POLL_INTERVAL_SECONDS=60
EOF

chown root:root /srv/alerts-ua/env/.env.api /srv/alerts-ua/env/.env.worker
chmod 600 /srv/alerts-ua/env/.env.api /srv/alerts-ua/env/.env.worker

echo "postgresql=$(systemctl is-active postgresql)"
echo "redis=$(systemctl is-active redis-server)"
echo "dtek=$(systemctl is-active dtek-api.service)"
echo "env_files_created=ok"
