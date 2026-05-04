-- Create function to archive old threat overlays
-- This should be called periodically (e.g., daily) to clean up old threats

CREATE OR REPLACE FUNCTION archive_old_threat_overlays()
RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  -- Archive overlays older than 1 day that are still active
  -- Threats are only displayed in app for 1 hour max, so 1 day retention is sufficient
  UPDATE threat_visual_overlays tvo
  SET status = 'archived',
      updated_at = NOW()
  WHERE status = 'active'
    AND vector_id IN (
      SELECT tv.vector_id
      FROM threat_vectors tv
      WHERE tv.occurred_at < NOW() - INTERVAL '1 day'
        AND tv.expires_at < NOW()  -- Already expired
        AND NOT EXISTS (
          -- Don't archive if there are recent alerts in the region
          SELECT 1
          FROM air_raid_state_current arc
          JOIN region_catalog rc ON rc.uid = COALESCE(tv.target_uid, tv.origin_uid)
          WHERE rc.uid = COALESCE(tv.target_uid, tv.origin_uid)
            AND arc.status IN ('A', 'P')
        )
    );

  GET DIAGNOSTICS archived_count = ROW_COUNT;

  -- Log the result
  RAISE NOTICE 'Archived % threat overlays (older than 1 day and expired)', archived_count;

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- Create indexes for better performance of archive query
CREATE INDEX IF NOT EXISTS idx_threat_vectors_archive_candidates
ON threat_vectors(occurred_at, expires_at)
WHERE occurred_at < NOW() - INTERVAL '7 days';

CREATE INDEX IF NOT EXISTS idx_threat_visual_overlays_active_for_archive
ON threat_visual_overlays(status, created_at)
WHERE status = 'active';

-- Add comment
COMMENT ON FUNCTION archive_old_threat_overlays() IS
  'Archives threat overlays older than 7 days that are already expired. Returns number of archived records.';
