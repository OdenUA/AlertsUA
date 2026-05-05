#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH=""
RELEASE_NAME=""
APP_USER="${APP_USER:-alerts-ua}"
APP_GROUP="${APP_GROUP:-alerts-ua}"
CURRENT_LINK="${CURRENT_LINK:-/srv/alerts-ua/app/current}"
RELEASES_DIR="${RELEASES_DIR:-/srv/alerts-ua/app/releases}"
RUNTIME_NPM="${RUNTIME_NPM:-/usr/bin/npm}"
API_SERVICE="${API_SERVICE:-alerts-ua-api.service}"
DTEK_SERVICE="${DTEK_SERVICE:-dtek-api.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/v1/system/health}"
FORCE_NPM_INSTALL="${FORCE_NPM_INSTALL:-0}"

usage() {
  cat <<'EOF'
Usage: deploy_backend_release.sh --archive /tmp/backend-release.tgz [--release-name deploy-YYYYMMDD-HHMMSS]

Environment overrides:
  APP_USER           default: alerts-ua
  APP_GROUP          default: alerts-ua
  CURRENT_LINK       default: /srv/alerts-ua/app/current
  RELEASES_DIR       default: /srv/alerts-ua/app/releases
  RUNTIME_NPM        default: /usr/bin/npm
  API_SERVICE        default: alerts-ua-api.service
  DTEK_SERVICE       default: dtek-api.service
  HEALTH_URL         default: http://127.0.0.1:3100/api/v1/system/health
  FORCE_NPM_INSTALL  default: 0
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_PATH="$2"
      shift 2
      ;;
    --release-name)
      RELEASE_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ARCHIVE_PATH" ]]; then
  echo "--archive is required" >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi

if [[ -z "$RELEASE_NAME" ]]; then
  RELEASE_NAME="deploy-$(date +%Y%m%d-%H%M%S)"
fi

if ! systemctl is-active --quiet "$DTEK_SERVICE"; then
  echo "Safety check failed: $DTEK_SERVICE is not active before deploy" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"

PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
NEW_RELEASE="$RELEASES_DIR/$RELEASE_NAME"

if [[ -e "$NEW_RELEASE" ]]; then
  echo "Release already exists: $NEW_RELEASE" >&2
  exit 1
fi

PREVIOUS_PACKAGE_JSON_SUM=""
PREVIOUS_PACKAGE_LOCK_SUM=""

if [[ -n "$PREVIOUS_RELEASE" && -f "$PREVIOUS_RELEASE/package.json" ]]; then
  PREVIOUS_PACKAGE_JSON_SUM="$(sha256sum "$PREVIOUS_RELEASE/package.json" | awk '{print $1}')"
fi

if [[ -n "$PREVIOUS_RELEASE" && -f "$PREVIOUS_RELEASE/package-lock.json" ]]; then
  PREVIOUS_PACKAGE_LOCK_SUM="$(sha256sum "$PREVIOUS_RELEASE/package-lock.json" | awk '{print $1}')"
fi

cleanup() {
  rm -f "$ARCHIVE_PATH"
}

rollback() {
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
    systemctl restart "$API_SERVICE"
  fi
}

check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl --silent --show-error --fail "$HEALTH_URL" >/dev/null
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$HEALTH_URL" >/dev/null
    return
  fi

  echo "Neither curl nor wget is available for health checks" >&2
  return 1
}

trap cleanup EXIT

install -d -o "$APP_USER" -g "$APP_GROUP" "$NEW_RELEASE"

if [[ -n "$PREVIOUS_RELEASE" ]]; then
  cp -a "$CURRENT_LINK/." "$NEW_RELEASE/"
fi

rm -rf "$NEW_RELEASE/dist" "$NEW_RELEASE/scripts" "$NEW_RELEASE/sql" "$NEW_RELEASE/src"
rm -f \
  "$NEW_RELEASE/package.json" \
  "$NEW_RELEASE/package-lock.json" \
  "$NEW_RELEASE/nest-cli.json" \
  "$NEW_RELEASE/tsconfig.json" \
  "$NEW_RELEASE/tsconfig.build.json"

tar -xzf "$ARCHIVE_PATH" -C "$NEW_RELEASE"
chown -R "$APP_USER:$APP_GROUP" "$NEW_RELEASE"

NEEDS_NPM_INSTALL="$FORCE_NPM_INSTALL"

if [[ ! -d "$NEW_RELEASE/node_modules" ]]; then
  NEEDS_NPM_INSTALL="1"
fi

if [[ "$NEEDS_NPM_INSTALL" != "1" ]]; then
  NEW_PACKAGE_JSON_SUM="$(sha256sum "$NEW_RELEASE/package.json" | awk '{print $1}')"
  NEW_PACKAGE_LOCK_SUM="$(sha256sum "$NEW_RELEASE/package-lock.json" | awk '{print $1}')"
  if [[ "$NEW_PACKAGE_JSON_SUM" != "$PREVIOUS_PACKAGE_JSON_SUM" || "$NEW_PACKAGE_LOCK_SUM" != "$PREVIOUS_PACKAGE_LOCK_SUM" ]]; then
    NEEDS_NPM_INSTALL="1"
  fi
fi

if [[ "$NEEDS_NPM_INSTALL" == "1" ]]; then
  if [[ ! -x "$RUNTIME_NPM" ]]; then
    echo "Runtime npm not found: $RUNTIME_NPM" >&2
    exit 1
  fi

  rm -rf "$NEW_RELEASE/node_modules"
  (
    cd "$NEW_RELEASE"
    runuser -u "$APP_USER" -- "$RUNTIME_NPM" ci --omit=dev
  )
fi

ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"
systemctl restart "$API_SERVICE"

if ! systemctl is-active --quiet "$API_SERVICE"; then
  echo "API service failed to start after deploy, rolling back" >&2
  rollback
  exit 1
fi

HEALTH_OK="0"
for _attempt in $(seq 1 15); do
  if check_health; then
    HEALTH_OK="1"
    break
  fi
  sleep 2
done

if [[ "$HEALTH_OK" != "1" ]]; then
  echo "Health check failed after deploy, rolling back" >&2
  rollback
  exit 1
fi

if ! systemctl is-active --quiet "$DTEK_SERVICE"; then
  echo "Safety check failed: $DTEK_SERVICE is not active after deploy" >&2
  rollback
  exit 1
fi

echo "release=$NEW_RELEASE"
echo "api=$(systemctl is-active "$API_SERVICE")"
echo "dtek=$(systemctl is-active "$DTEK_SERVICE")"
echo "health=ok"