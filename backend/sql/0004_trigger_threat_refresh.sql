-- Replace cron with trigger-based refresh of materialized view
-- This refreshes immediately when new threat data arrives

-- 1. Create a function to refresh the materialized view
CREATE OR REPLACE FUNCTION refresh_threat_overlays_fast()
RETURNS TRIGGER AS $$
BEGIN
  -- Refresh materialized view asynchronously (not blocking inserts)
  -- Using CONCURRENTLY to avoid locking
  REFRESH MATERIALIZED VIEW CONCURRENTLY threat_overlays_fast;

  -- Invalidate Redis cache by publishing to a channel
  PERFORM pg_notify('threats_updated', JSON_BUILD_OBJECT(
    'action', 'refresh',
    'timestamp', NOW()
  )::text);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 2. Create trigger on threat_vectors INSERT/UPDATE/DELETE
DROP TRIGGER IF EXISTS trigger_refresh_threat_overlays_vectors ON threat_vectors;

CREATE TRIGGER trigger_refresh_threat_overlays_vectors
AFTER INSERT OR UPDATE OR DELETE ON threat_vectors
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_threat_overlays_fast();

-- 3. Also create trigger on threat_visual_overlays (status changes)
DROP TRIGGER IF EXISTS trigger_refresh_threat_overlays_overlays ON threat_visual_overlays;

CREATE TRIGGER trigger_refresh_threat_overlays_overlays
AFTER INSERT OR UPDATE OR DELETE ON threat_visual_overlays
FOR EACH STATEMENT
EXECUTE FUNCTION refresh_threat_overlays_fast();

-- 4. Add comment for documentation
COMMENT ON FUNCTION refresh_threat_overlays_fast() IS
  'Trigger function that refreshes threat_overlays_fast materialized view and publishes Redis invalidation whenever threat data changes';
