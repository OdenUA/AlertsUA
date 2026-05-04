-- Optimize threat overlays performance with materialized view and indexes

-- Drop existing materialized view if it exists during migration
DROP MATERIALIZED VIEW IF EXISTS threat_overlays_fast CASCADE;

-- Create fast materialized view for threat overlays
-- Pre-computes all GeoJSON transformations and simplifies the complex logic
CREATE MATERIALIZED VIEW threat_overlays_fast AS
SELECT
  tvo.overlay_id,
  tv.vector_id,
  tv.threat_kind,
  tv.confidence,
  tv.movement_bearing_deg,
  tv.icon_type,
  tv.color_hex,
  tv.occurred_at,  -- Keep as timestamp for proper filtering
  tv.expires_at,
  COALESCE(tmr.message_text, '') AS message_text,
  tmr.message_date,
  -- Pre-compute GeoJSON to avoid ST_AsGeoJSON calls
  COALESCE(
    ST_AsGeoJSON(COALESCE(tv.origin_geom, tv.target_geom))::text,
    ''
  ) AS marker_json,
  COALESCE(ST_AsGeoJSON(tv.corridor_geom)::text, '') AS corridor_json,
  COALESCE(ST_AsGeoJSON(tv.danger_area_geom)::text, '') AS area_json,
  -- Pre-compute region anchoring data
  COALESCE(tv.target_uid, tv.origin_uid) AS anchor_uid,
  tv.target_uid,
  tv.origin_uid,
  -- Timestamp for refresh logic
  NOW() AS materialized_at
FROM threat_visual_overlays tvo
JOIN threat_vectors tv ON tv.vector_id = tvo.vector_id
LEFT JOIN telegram_messages_raw tmr ON tmr.raw_message_id = tv.raw_message_id
WHERE tvo.status = 'active'
  AND tv.occurred_at > NOW() - INTERVAL '7 days';  -- Only recent threats

-- Create unique index on materialized view for fast lookups
CREATE UNIQUE INDEX idx_threat_overlays_fast_overlay_id
  ON threat_overlays_fast(overlay_id);

-- Create index for active status filtering (without volatile functions)
CREATE INDEX idx_threat_overlays_fast_occurred
  ON threat_overlays_fast(occurred_at DESC);

-- Create index for region-based queries
CREATE INDEX idx_threat_overlays_fast_anchor
  ON threat_overlays_fast(anchor_uid)
  WHERE anchor_uid IS NOT NULL;

-- Create indexes to improve original query performance
CREATE INDEX IF NOT EXISTS idx_threat_vectors_target_uid_active
  ON threat_vectors(target_uid)
  WHERE target_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threat_vectors_origin_uid_active
  ON threat_vectors(origin_uid)
  WHERE origin_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threat_vectors_occurred_active
  ON threat_vectors(occurred_at DESC)
  WHERE occurred_at > NOW() - INTERVAL '7 days';

-- Create composite index for complex WHERE clause
CREATE INDEX IF NOT EXISTS idx_threat_vectors_active_composite
  ON threat_vectors(target_uid, origin_uid, occurred_at DESC)
  WHERE occurred_at > NOW() - INTERVAL '7 days';

-- Add comment for documentation
COMMENT ON MATERIALIZED VIEW threat_overlays_fast IS
  'Optimized materialized view for threat overlays with pre-computed GeoJSON and simplified access pattern. Refresh via: REFRESH MATERIALIZED VIEW CONCURRENTLY threat_overlays_fast;';
