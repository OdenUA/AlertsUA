CREATE TABLE IF NOT EXISTS regions_ref (
  uid INTEGER PRIMARY KEY,
  region_type TEXT NOT NULL,
  title_uk TEXT NOT NULL,
  parent_uid INTEGER NULL,
  oblast_uid INTEGER NULL,
  raion_uid INTEGER NULL,
  source_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS devices (
  installation_id UUID PRIMARY KEY,
  platform TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'uk-UA',
  app_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS device_push_tokens (
  token_id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES devices(installation_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES devices(installation_id) ON DELETE CASCADE,
  label_user TEXT NULL,
  address_uk TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  leaf_uid INTEGER NULL,
  raion_uid INTEGER NULL,
  oblast_uid INTEGER NULL,
  notify_on_start BOOLEAN NOT NULL,
  notify_on_end BOOLEAN NOT NULL,
  is_active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_event_log (
  event_id UUID PRIMARY KEY,
  uid INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  previous_status CHAR(1) NOT NULL,
  new_status CHAR(1) NOT NULL,
  state_version BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() AT TIME ZONE 'Europe/Kyiv'
);

CREATE TABLE IF NOT EXISTS notification_log (
  dispatch_id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES devices(installation_id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES alert_event_log(event_id) ON DELETE CASCADE,
  dispatch_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT NULL,
  provider_error_code TEXT NULL,
  queued_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NULL
);
