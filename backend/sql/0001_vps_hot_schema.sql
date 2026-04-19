-- Run `CREATE EXTENSION IF NOT EXISTS postgis;` separately with a PostgreSQL superuser
-- before applying the rest of this schema file.

CREATE TABLE IF NOT EXISTS region_catalog (
  uid INTEGER PRIMARY KEY,
  region_type TEXT NOT NULL CHECK (region_type IN ('oblast', 'raion', 'city', 'hromada', 'unknown')),
  title_uk TEXT NOT NULL,
  parent_uid INTEGER NULL,
  oblast_uid INTEGER NULL,
  raion_uid INTEGER NULL,
  source_kind TEXT NOT NULL DEFAULT 'xlsx_snapshot',
  source_path TEXT NULL,
  source_sheet TEXT NULL,
  source_row_hash TEXT NOT NULL,
  source_version TEXT NOT NULL,
  is_subscription_leaf BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE INDEX IF NOT EXISTS idx_region_catalog_parent_uid ON region_catalog(parent_uid);
CREATE INDEX IF NOT EXISTS idx_region_catalog_oblast_uid ON region_catalog(oblast_uid);
CREATE INDEX IF NOT EXISTS idx_region_catalog_raion_uid ON region_catalog(raion_uid);
CREATE INDEX IF NOT EXISTS idx_region_catalog_region_type ON region_catalog(region_type);

CREATE TABLE IF NOT EXISTS region_geometry (
  uid INTEGER PRIMARY KEY REFERENCES region_catalog(uid) ON DELETE CASCADE,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  centroid geometry(Point, 4326) NULL,
  bbox geometry(Polygon, 4326) NULL,
  source_geometry_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE INDEX IF NOT EXISTS idx_region_geometry_geom ON region_geometry USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_region_geometry_bbox ON region_geometry USING GIST (bbox);

CREATE TABLE IF NOT EXISTS region_geometry_lod (
  uid INTEGER NOT NULL REFERENCES region_catalog(uid) ON DELETE CASCADE,
  lod TEXT NOT NULL CHECK (lod IN ('low', 'medium', 'high')),
  geom geometry(MultiPolygon, 4326) NOT NULL,
  simplification_meters INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  PRIMARY KEY (uid, lod)
);

CREATE INDEX IF NOT EXISTS idx_region_geometry_lod_geom ON region_geometry_lod USING GIST (geom);

CREATE TABLE IF NOT EXISTS region_import_runs (
  import_id UUID PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_version TEXT NOT NULL,
  workbook_hash TEXT NOT NULL,
  sheet_names JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  rows_total INTEGER NOT NULL,
  rows_inserted INTEGER NOT NULL,
  rows_updated INTEGER NOT NULL,
  rows_skipped INTEGER NOT NULL,
  error_summary TEXT NULL
);

CREATE TABLE IF NOT EXISTS alert_poll_cycles (
  cycle_id BIGSERIAL PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NULL,
  http_status INTEGER NOT NULL,
  if_modified_since_sent TEXT NULL,
  last_modified_received TEXT NULL,
  status_string_hash TEXT NULL,
  changed BOOLEAN NOT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL
);

CREATE TABLE IF NOT EXISTS air_raid_state_current (
  uid INTEGER PRIMARY KEY REFERENCES region_catalog(uid) ON DELETE CASCADE,
  status CHAR(1) NOT NULL CHECK (status IN ('A', 'P', 'N', ' ')),
  state_version BIGINT NOT NULL,
  active_from TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_cycle_id BIGINT NOT NULL REFERENCES alert_poll_cycles(cycle_id),
  alert_type TEXT NOT NULL DEFAULT 'air_raid'
);

CREATE TABLE IF NOT EXISTS air_raid_events (
  event_id UUID PRIMARY KEY,
  uid INTEGER NOT NULL REFERENCES region_catalog(uid) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('started', 'ended', 'state_changed')),
  previous_status CHAR(1) NOT NULL,
  new_status CHAR(1) NOT NULL,
  alert_type TEXT NOT NULL DEFAULT 'air_raid',
  state_version BIGINT NOT NULL,
  source_cycle_id BIGINT NOT NULL REFERENCES alert_poll_cycles(cycle_id),
  occurred_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS device_installations (
  installation_id UUID PRIMARY KEY,
  installation_token_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'android',
  locale TEXT NOT NULL DEFAULT 'uk-UA',
  app_version TEXT NOT NULL,
  app_build TEXT NULL,
  device_model TEXT NULL,
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS device_push_tokens (
  token_id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES device_installations(installation_id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  last_success_at TIMESTAMPTZ NULL,
  last_error_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES device_installations(installation_id) ON DELETE CASCADE,
  label_user TEXT NULL,
  address_uk TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  point geometry(Point, 4326) NOT NULL,
  leaf_uid INTEGER NULL REFERENCES region_catalog(uid),
  raion_uid INTEGER NULL REFERENCES region_catalog(uid),
  oblast_uid INTEGER NULL REFERENCES region_catalog(uid),
  notify_on_start BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_end BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_installation_id ON subscriptions(installation_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_leaf_uid ON subscriptions(leaf_uid);
CREATE INDEX IF NOT EXISTS idx_subscriptions_raion_uid ON subscriptions(raion_uid);
CREATE INDEX IF NOT EXISTS idx_subscriptions_oblast_uid ON subscriptions(oblast_uid);
CREATE INDEX IF NOT EXISTS idx_subscriptions_point ON subscriptions USING GIST (point);

CREATE TABLE IF NOT EXISTS subscription_runtime_state (
  subscription_id UUID PRIMARY KEY REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  effective_status CHAR(1) NOT NULL CHECK (effective_status IN ('A', 'P', 'N', ' ')),
  effective_uid INTEGER NULL REFERENCES region_catalog(uid),
  effective_started_at TIMESTAMPTZ NULL,
  last_transition_at TIMESTAMPTZ NOT NULL,
  last_evaluated_state_version BIGINT NOT NULL,
  last_start_event_id UUID NULL REFERENCES air_raid_events(event_id),
  last_end_event_id UUID NULL REFERENCES air_raid_events(event_id)
);

CREATE TABLE IF NOT EXISTS notification_dispatches (
  dispatch_id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES device_installations(installation_id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES device_push_tokens(token_id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES air_raid_events(event_id) ON DELETE CASCADE,
  dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('start', 'end')),
  title_uk TEXT NOT NULL,
  body_uk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'deduplicated', 'skipped')),
  attempt_no INTEGER NOT NULL DEFAULT 1,
  provider_message_id TEXT NULL,
  provider_error_code TEXT NULL,
  queued_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  UNIQUE (subscription_id, event_id, dispatch_kind)
);

CREATE TABLE IF NOT EXISTS geocoder_cache (
  cache_key TEXT PRIMARY KEY,
  query_uk TEXT NOT NULL,
  provider TEXT NOT NULL,
  response_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS supabase_outbox (
  outbox_id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  processed_at TIMESTAMPTZ NULL
);
