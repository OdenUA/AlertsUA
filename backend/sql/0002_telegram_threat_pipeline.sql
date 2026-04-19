-- Telegram + LLM threat overlay pipeline

CREATE TABLE IF NOT EXISTS telegram_channels (
  channel_id TEXT PRIMARY KEY,
  channel_ref TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_message_id BIGINT NULL,
  last_polled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_messages_raw (
  raw_message_id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES telegram_channels(channel_id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  message_date TIMESTAMPTZ NOT NULL,
  message_text TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS llm_parse_jobs (
  job_id UUID PRIMARY KEY,
  raw_message_id BIGINT NOT NULL REFERENCES telegram_messages_raw(raw_message_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NULL,
  processed_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(raw_message_id)
);

CREATE TABLE IF NOT EXISTS threat_vectors (
  vector_id UUID PRIMARY KEY,
  raw_message_id BIGINT NOT NULL REFERENCES telegram_messages_raw(raw_message_id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES llm_parse_jobs(job_id) ON DELETE CASCADE,
  threat_kind TEXT NOT NULL CHECK (threat_kind IN ('uav', 'kab', 'missile', 'unknown')),
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  region_hint TEXT NULL,
  origin_hint TEXT NULL,
  target_hint TEXT NULL,
  direction_text TEXT NULL,
  origin_uid INTEGER NULL REFERENCES region_catalog(uid),
  target_uid INTEGER NULL REFERENCES region_catalog(uid),
  origin_geom geometry(Point, 4326) NULL,
  target_geom geometry(Point, 4326) NULL,
  corridor_geom geometry(LineString, 4326) NULL,
  danger_area_geom geometry(Geometry, 4326) NULL,
  movement_bearing_deg NUMERIC(6,2) NULL,
  icon_type TEXT NOT NULL,
  color_hex TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  parsed_payload JSONB NOT NULL,
  normalized_dedupe_key TEXT NOT NULL UNIQUE,
  resolved_air_raid_event_id UUID NULL REFERENCES air_raid_events(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS threat_visual_overlays (
  overlay_id UUID PRIMARY KEY,
  vector_id UUID NOT NULL REFERENCES threat_vectors(vector_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  render_priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vector_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_messages_channel_message
  ON telegram_messages_raw(channel_id, message_id DESC);

CREATE INDEX IF NOT EXISTS idx_llm_parse_jobs_status_created
  ON llm_parse_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_occurred
  ON threat_vectors(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_expires
  ON threat_vectors(expires_at);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_confidence
  ON threat_vectors(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_origin_geom
  ON threat_vectors USING GIST(origin_geom);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_target_geom
  ON threat_vectors USING GIST(target_geom);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_corridor_geom
  ON threat_vectors USING GIST(corridor_geom);

CREATE INDEX IF NOT EXISTS idx_threat_vectors_danger_area_geom
  ON threat_vectors USING GIST(danger_area_geom);

CREATE INDEX IF NOT EXISTS idx_threat_overlays_status_priority
  ON threat_visual_overlays(status, render_priority, updated_at DESC);
