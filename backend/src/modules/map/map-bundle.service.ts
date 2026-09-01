import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';
import type {
  FeaturesBundleDto,
  MapBundleDto,
  FeatureSubset,
} from '../../common/cache/dto/cache-bundle.dto';

type FeatureGeometryRow = {
  uid: number;
  title_uk: string;
  region_type: string;
  parent_uid: number | null;
  oblast_uid: number | null;
  geometry_json: string;
};

type StatusRow = {
  uid: number;
  status: 'A' | 'P' | 'N' | ' ';
  alert_type: string;
};

type AlertLayerUidRow = {
  uid: number;
  region_type: string;
  alert_type: string;
};

const OCCUPIED_TERRITORIES_FILE = path.join(__dirname, '../../../data/occupied-territories.geojson');

@Injectable()
export class MapBundleService {
  private readonly logger = new Logger(MapBundleService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async buildFeaturesBundle(
    layer: string,
    lod: string,
    bbox?: { west: number; south: number; east: number; north: number },
  ): Promise<FeaturesBundleDto> {
    if (!this.databaseService.isConfigured()) {
      throw new Error('Database not configured');
    }

    const regionTypes = this.resolveLayerRegionTypes(layer);
    const values: unknown[] = [regionTypes, lod];
    let bboxClause = '';

    if (bbox) {
      values.push(bbox.west, bbox.south, bbox.east, bbox.north);
      bboxClause = `
        AND COALESCE(rgl.geom, rg.geom) && ST_MakeEnvelope($3, $4, $5, $6, 4326)
        AND ST_Intersects(COALESCE(rgl.geom, rg.geom), ST_MakeEnvelope($3, $4, $5, $6, 4326))
      `;
    }

    const result = await this.databaseService.query<FeatureGeometryRow>(
      `
        SELECT rc.uid,
               rc.title_uk,
               rc.region_type,
               rc.parent_uid,
               rc.oblast_uid,
               ST_AsGeoJSON(COALESCE(rgl.geom, rg.geom)) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = $2
        WHERE rc.is_active = TRUE
          AND rc.region_type = ANY($1::text[])
          ${bboxClause}
        ORDER BY rc.uid ASC
      `,
      values,
    );

    const geometries = result.rows.map((row) => ({
      uid: row.uid,
      title_uk: row.title_uk,
      region_type: row.region_type,
      parent_uid: row.parent_uid,
      oblast_uid: row.oblast_uid,
      geometry: JSON.parse(row.geometry_json),
    }));

    return {
      layer,
      lod,
      bbox: bbox ? `${bbox.west},${bbox.south},${bbox.east},${bbox.north}` : undefined,
      generated_at: TimeUtil.getNowInKyiv(),
      features: {
        geometries,
        status_lookup: {},
      },
    };
  }

  mergeAlertsStatus(bundle: FeaturesBundleDto, alertsBundle: any): void {
    if (!alertsBundle?.active_alerts?.features) return;

    const statusMap: Record<number, { status: string; alert_type: string }> = {};
    for (const alert of alertsBundle.active_alerts.features) {
      statusMap[alert.uid] = {
        status: 'A',
        alert_type: alert.alert_type,
      };
    }

    bundle.features.status_lookup = statusMap;
  }

  /**
   * Lightweight status-only bundle (~10-20KB).
   * Contains status_lookup and active_alert_uids — NO geometry.
   * Client loads geometry from local assets and applies statuses locally.
   */
  async buildFullMapBundle(stateVersion?: number): Promise<MapBundleDto> {
    if (!this.databaseService.isConfigured()) {
      throw new Error('Database not configured');
    }

    // 1. All statuses — single lightweight query
    const statusResult = await this.databaseService.query<StatusRow>(
      `SELECT uid, status, alert_type FROM air_raid_state_current ORDER BY uid ASC`,
    );

    // 2. Alerts layer UIDs only (no geometry)
    const alertsLayerResult = await this.databaseService.query<AlertLayerUidRow>(
      `SELECT uid, region_type, alert_type FROM alert_layer_features ORDER BY uid ASC`,
    );

    // 3. Layer counts — lightweight COUNT queries
    const layerCountsResult = await this.databaseService.query<{
      layer: string;
      lod: string;
      cnt: number;
    }>(
      `
        SELECT 'oblast' AS layer, 'low' AS lod,
               COUNT(*)::int AS cnt
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = ANY($1::text[])
        UNION ALL
        SELECT 'oblast', 'medium',
               COUNT(*)::int
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = ANY($1::text[])
        UNION ALL
        SELECT 'raion', 'medium',
               COUNT(*)::int
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = 'raion'
        UNION ALL
        SELECT 'raion', 'high',
               COUNT(*)::int
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = 'raion'
        UNION ALL
        SELECT 'hromada', 'medium',
               COUNT(*)::int
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = 'hromada'
        UNION ALL
        SELECT 'hromada', 'high',
               COUNT(*)::int
        FROM region_catalog
        WHERE is_active = TRUE AND region_type = 'hromada'
      `,
      [['oblast', 'city']],
    );

    // Build status_lookup — only for regions with non-default status
    const statusLookup: Record<number, { status: string; alert_type: string }> = {};
    const activeAlertUids: number[] = [];

    for (const row of statusResult.rows) {
      if (row.status === 'A') {
        activeAlertUids.push(row.uid);
      }
      // Only include non-default statuses to keep bundle small
      if (row.status !== ' ') {
        statusLookup[row.uid] = {
          status: row.status,
          alert_type: row.alert_type,
        };
      }
    }

    // Build alerts layer (uid-only, no geometry)
    const alertsLayerFeatures = alertsLayerResult.rows.map((row) => ({
      uid: row.uid,
      region_type: row.region_type,
      alert_type: row.alert_type,
    }));

    // Build layer_counts map
    const layerCounts: MapBundleDto['layer_counts'] = {
      'oblast:low': 0,
      'oblast:medium': 0,
      'raion:medium': 0,
      'raion:high': 0,
      'hromada:medium': 0,
      'hromada:high': 0,
    };
    for (const row of layerCountsResult.rows) {
      const key = `${row.layer}:${row.lod}` as keyof MapBundleDto['layer_counts'];
      layerCounts[key] = row.cnt;
    }

    // Count occupied territories (fast file check)
    const occupiedCount = this.getOccupiedTerritoriesCount();

    const currentStateVersion =
      stateVersion ??
      statusResult.rows.reduce((max) => max, 0);

    return {
      state_version: currentStateVersion,
      generated_at: TimeUtil.getNowInKyiv(),
      active_alert_uids: activeAlertUids,
      status_lookup: statusLookup,
      alerts_layer: { features: alertsLayerFeatures },
      layer_counts: layerCounts,
      active_alerts_count: activeAlertUids.length,
      simplified_oblast_count: layerCountsResult.rows.find(r => r.layer === 'oblast')?.cnt ?? 0,
      occupied_territories_count: occupiedCount,
      threat_overlay_count: 0, // Will be set by threat bundle
    };
  }

  /**
   * Lightweight threat bundle — no geometry, just overlay metadata.
   */
  async buildThreatBundle(): Promise<{
    generated_at: string;
    bucket_ts: number;
    overlay_count: number;
    overlays: Array<{
      overlay_id: string;
      vector_id: string;
      threat_kind: string;
      confidence: number;
      movement_bearing_deg: number | null;
      icon_type: string;
      color_hex: string;
      occurred_at: string;
      expires_at: string | null;
      message_text: string | null;
      message_date: string | null;
      source_excerpt: string | null;
      channel_ref: string | null;
      // Geometry references — client looks up in local assets
      has_marker: boolean;
      has_corridor: boolean;
      has_area: boolean;
    }>;
  }> {
    if (!this.databaseService.isConfigured()) {
      throw new Error('Database not configured');
    }

    // Grace window for fresh reports before the official alert is raised in the
    // target region. Must stay shorter than the max-visible window so that
    // anchored threats disappear as soon as the region alert ends.
    const THREAT_OVERLAY_PENDING_ALERT_INTERVAL_SQL = "INTERVAL '15 minutes'";
    // Per-kind visibility window: uav 45 min, kab/missile/unknown 30 min.
    const THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL = `CASE WHEN tv.threat_kind = 'uav' THEN INTERVAL '45 minutes' ELSE INTERVAL '30 minutes' END`;

    const result = await this.databaseService.query<{
      overlay_id: string;
      vector_id: string;
      threat_kind: string;
      confidence: number;
      movement_bearing_deg: number | null;
      icon_type: string;
      color_hex: string;
      occurred_at: string;
      expires_at: string | null;
      message_text: string | null;
      message_date: string | null;
      source_excerpt: string | null;
      channel_ref: string | null;
      has_marker: boolean;
      has_corridor: boolean;
      has_area: boolean;
    }>(
      `
        SELECT tvo.overlay_id,
               tv.vector_id,
               tv.threat_kind,
               tv.confidence,
               tv.movement_bearing_deg,
               tv.icon_type,
               tv.color_hex,
               tv.occurred_at::text,
               tv.expires_at::text,
               tmr.message_text,
               tmr.message_date::text AS message_date,
               tv.source_excerpt,
               tmr.channel_id AS channel_ref,
               (tv.origin_geom IS NOT NULL OR tv.target_geom IS NOT NULL) AS has_marker,
               (tv.corridor_geom IS NOT NULL) AS has_corridor,
               (tv.danger_area_geom IS NOT NULL) AS has_area
        FROM threat_visual_overlays tvo
        JOIN threat_vectors tv ON tv.vector_id = tvo.vector_id
        LEFT JOIN telegram_messages_raw tmr ON tmr.raw_message_id = tv.raw_message_id
        LEFT JOIN region_catalog rc_anchor ON rc_anchor.uid = COALESCE(tv.target_uid, tv.origin_uid)
        LEFT JOIN air_raid_state_current arc_raion
          ON arc_raion.uid = COALESCE(rc_anchor.raion_uid, rc_anchor.uid)
        WHERE tvo.status = 'active'
          AND (
            (
              COALESCE(tv.target_uid, tv.origin_uid) IS NOT NULL
              AND tv.occurred_at + ${THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL} > NOW()
              AND (
                arc_raion.status IN ('A', 'P')
                OR tv.occurred_at + ${THREAT_OVERLAY_PENDING_ALERT_INTERVAL_SQL} > NOW()
              )
            )
            OR (
              COALESCE(tv.target_uid, tv.origin_uid) IS NULL
              AND COALESCE(tv.expires_at, tv.occurred_at + ${THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL}) > NOW()
            )
          )
        ORDER BY tvo.render_priority ASC, tv.occurred_at DESC
      `,
    );

    const overlays = result.rows.map((row) => ({
      overlay_id: row.overlay_id,
      vector_id: row.vector_id,
      threat_kind: row.threat_kind,
      confidence: Number(row.confidence),
      movement_bearing_deg: row.movement_bearing_deg,
      icon_type: row.icon_type,
      color_hex: row.color_hex,
      occurred_at: row.occurred_at,
      expires_at: row.expires_at,
      message_text: row.message_text,
      message_date: row.message_date,
      source_excerpt: row.source_excerpt,
      channel_ref: row.channel_ref,
      has_marker: row.has_marker,
      has_corridor: row.has_corridor,
      has_area: row.has_area,
    }));

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      bucket_ts: Math.floor(Date.now() / 60000) * 60000,
      overlay_count: overlays.length,
      overlays,
    };
  }

  private getOccupiedTerritoriesCount(): number {
    try {
      if (!fs.existsSync(OCCUPIED_TERRITORIES_FILE)) {
        return 0;
      }
      const rawContent = fs.readFileSync(OCCUPIED_TERRITORIES_FILE, 'utf8');
      const data = JSON.parse(rawContent) as { features?: unknown[] };
      return data.features?.length ?? 0;
    } catch {
      return 0;
    }
  }

  private resolveLayerRegionTypes(layer: string) {
    switch (layer) {
      case 'oblast':
        return ['oblast', 'city'];
      case 'raion':
        return ['raion'];
      case 'hromada':
        return ['hromada'];
      default:
        throw new Error('Unknown layer type');
    }
  }
}
