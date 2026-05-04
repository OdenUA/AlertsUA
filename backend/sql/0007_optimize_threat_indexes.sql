-- Optimize indexes for threat overlays query performance
-- These indexes significantly improve the complex query in getThreatOverlays()

-- 1. Composite index for the main query pattern (status + render_priority)
-- This speeds up the ORDER BY and status filtering
DROP INDEX IF EXISTS idx_threat_overlays_status_priority;
CREATE INDEX idx_threat_overlays_status_priority
ON threat_visual_overlays(status, render_priority, updated_at DESC)
WHERE status = 'active';  -- Partial index: only active records

-- 2. Index for threat_vectors time-based queries
-- Improves filtering by occurred_at and expiry
DROP INDEX IF EXISTS idx_threat_vectors_occurred;
CREATE INDEX idx_threat_vectors_occurred_expires
ON threat_vectors(occurred_at DESC, expires_at);

-- 3. Covering index for JOIN between threat_visual_overlays and threat_vectors
-- This includes all columns needed for the JOIN without accessing the table
DROP INDEX IF EXISTS idx_threat_overlays_active_vectors;
CREATE INDEX idx_threat_overlays_active_vectors
ON threat_visual_overlays(status, vector_id)
WHERE status = 'active';

-- 4. Index for region-based filtering (target_uid/origin_uid)
-- Speeds up the geographic anchoring logic
DROP INDEX IF EXISTS idx_threat_vectors_target_uid;
CREATE INDEX idx_threat_vectors_target_origin_uids
ON threat_vectors(target_uid, origin_uid)
WHERE target_uid IS NOT NULL OR origin_uid IS NOT NULL;

-- 5. Index for LATERAL JOIN with air_raid_events
-- Speeds up the "first_ended_at" subquery
DROP INDEX IF EXISTS idx_air_raid_events_ended;
CREATE INDEX idx_air_raid_events_ended_lookup
ON air_raid_events(uid, occurred_at DESC)
WHERE event_kind = 'ended';

-- Add comments for documentation
COMMENT ON INDEX idx_threat_overlays_status_priority IS
  'Partial index for active threat overlays, speeds up status filtering and ORDER BY render_priority';

COMMENT ON INDEX idx_threat_vectors_occurred_expires IS
  'Partial time-based index for recent threats, improves expiry and occurred_at filtering';

COMMENT ON INDEX idx_threat_overlays_active_vectors IS
  'Covering index for active threat overlays JOIN, avoids table access for common queries';

COMMENT ON INDEX idx_threat_vectors_target_origin_uids IS
  'Index for geographic anchoring lookups, speeds up region-based threat filtering';

COMMENT ON INDEX idx_air_raid_events_ended_lookup IS
  'Index for LATERAL JOIN with air raid events, optimizes first_ended_at subquery';
