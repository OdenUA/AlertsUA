-- Alternative approach: NO materialized view, just Redis cache invalidation triggers
-- This is simpler and avoids maintaining a materialized view

-- 1. Create function to invalidate Redis cache when threats change
CREATE OR REPLACE FUNCTION invalidate_threats_cache()
RETURNS TRIGGER AS $$
BEGIN
  -- Send notification to backend to invalidate Redis cache
  PERFORM pg_notify('threats_cache_invalidate', JSON_BUILD_OBJECT(
    'action', 'invalidate',
    'table', TG_TABLE_NAME,
    'timestamp', NOW()
  )::text);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 2. Create triggers on threat_vectors
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_vectors ON threat_vectors;
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_vectors_update ON threat_vectors;
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_vectors_delete ON threat_vectors;

CREATE TRIGGER trigger_invalidate_threats_cache_vectors
AFTER INSERT ON threat_vectors
FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_threats_cache();

CREATE TRIGGER trigger_invalidate_threats_cache_vectors_update
AFTER UPDATE ON threat_vectors
FOR EACH STATEMENT
WHEN (
  OLD.occurred_at IS DISTINCT FROM NEW.occurred_at OR
  OLD.expires_at IS DISTINCT FROM NEW.expires_at OR
  OLD.origin_geom IS DISTINCT FROM NEW.origin_geom OR
  OLD.target_geom IS DISTINCT FROM NEW.target_geom OR
  OLD.danger_area_geom IS DISTINCT FROM NEW.danger_area_geom
)
EXECUTE FUNCTION invalidate_threats_cache();

CREATE TRIGGER trigger_invalidate_threats_cache_vectors_delete
AFTER DELETE ON threat_vectors
FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_threats_cache();

-- 3. Create triggers on threat_visual_overlays
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_overlays ON threat_visual_overlays;
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_overlays_update ON threat_visual_overlays;
DROP TRIGGER IF EXISTS trigger_invalidate_threats_cache_overlays_delete ON threat_visual_overlays;

CREATE TRIGGER trigger_invalidate_threats_cache_overlays
AFTER INSERT ON threat_visual_overlays
FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_threats_cache();

CREATE TRIGGER trigger_invalidate_threats_cache_overlays_update
AFTER UPDATE ON threat_visual_overlays
FOR EACH STATEMENT
WHEN (
  OLD.status IS DISTINCT FROM NEW.status OR
  OLD.render_priority IS DISTINCT FROM NEW.render_priority
)
EXECUTE FUNCTION invalidate_threats_cache();

CREATE TRIGGER trigger_invalidate_threats_cache_overlays_delete
AFTER DELETE ON threat_visual_overlays
FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_threats_cache();

-- 4. Create optimized indexes for the complex query (no materialized view)
CREATE INDEX IF NOT EXISTS idx_threat_vectors_active_query
ON threat_vectors(occurred_at DESC)
WHERE occurred_at > NOW() - INTERVAL '7 days';

CREATE INDEX IF NOT EXISTS idx_threat_visual_overlays_active_status
ON threat_visual_overlays(status, render_priority, created_at DESC)
WHERE status = 'active';

-- 5. Add comment
COMMENT ON FUNCTION invalidate_threats_cache() IS
  'Sends PostgreSQL notification to backend to invalidate Redis cache when threat data changes';
