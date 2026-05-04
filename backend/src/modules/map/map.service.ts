import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { calculateBearingDegrees, resolveMovementBearingDegrees } from '../../common/utils/bearing.util';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';
import { CacheService } from '../../common/cache/cache.service';
import { MapBundleService } from './map-bundle.service';
import { CACHE_KEYS, CACHE_TTL } from '../../common/cache/cache.constants';
import type { AlertsBundleDto, FeaturesBundleDto } from '../../common/cache/dto/cache-bundle.dto';

type MapFeatureRow = {
  uid: number;
  title_uk: string;
  region_type: string;
  parent_uid: number | null;
  oblast_uid: number | null;
  status: 'A' | 'P' | 'N' | ' ';
  alert_type: string;
  geometry_json: string;
};

type ActiveAlertRow = {
  uid: number;
  title_uk: string;
  region_type: string;
  alert_type: string;
  geometry_json: string;
};

type RegionIndexRow = {
  uid: number;
  title_uk: string;
  region_type: 'oblast' | 'city' | 'raion' | 'hromada';
  parent_uid: number | null;
  oblast_uid: number | null;
  raion_uid: number | null;
  has_geometry: boolean;
};

type RegionFeatureRow = {
  uid: number;
  title_uk: string;
  region_type: 'oblast' | 'city' | 'raion' | 'hromada';
  parent_uid: number | null;
  status: 'A' | 'P' | 'N' | ' ';
  geometry_json: string;
};

type ThreatOverlayRow = {
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
  marker_json: string | null;
  corridor_json: string | null;
  area_json: string | null;
};

const GEOMETRY_PACK_VERSION = 'ocha-cod-ab-v05';
const THREAT_OVERLAY_PENDING_ALERT_INTERVAL_SQL = "INTERVAL '1 hour'";
const THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL = "INTERVAL '1 hour'";
const THREAT_OVERLAY_ENDED_GRACE_PERIOD_SQL = "INTERVAL '5 minutes'";

@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cacheService: CacheService,
    private readonly mapBundleService: MapBundleService,
  ) {}

  async getRegions() {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        regions: [],
        note_uk: 'База даних недоступна. Ієрархію регіонів тимчасово не можна отримати.',
      };
    }

    const result = await this.databaseService.query<RegionIndexRow>(
      `
        SELECT rc.uid,
               rc.title_uk,
               rc.region_type,
               rc.parent_uid,
               rc.oblast_uid,
               rc.raion_uid,
               (rg.uid IS NOT NULL) AS has_geometry
        FROM region_catalog rc
        LEFT JOIN region_geometry rg ON rg.uid = rc.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type = ANY($1::text[])
        ORDER BY COALESCE(rc.oblast_uid, rc.uid) ASC,
                 COALESCE(rc.raion_uid, rc.uid) ASC,
                 CASE rc.region_type
                   WHEN 'oblast' THEN 0
                   WHEN 'city' THEN 1
                   WHEN 'raion' THEN 2
                   WHEN 'hromada' THEN 3
                   ELSE 4
                 END ASC,
                 rc.title_uk ASC,
                 rc.uid ASC
      `,
      [['oblast', 'city', 'raion', 'hromada']],
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      regions: result.rows.map((row) => ({
        uid: row.uid,
        title_uk: row.title_uk,
        region_type: row.region_type,
        parent_uid: row.parent_uid,
        oblast_uid: row.oblast_uid,
        raion_uid: row.raion_uid,
        has_geometry: row.has_geometry,
      })),
    };
  }

  async getFeatureByUid(uid: number) {
    if (!this.databaseService.isConfigured()) {
      return {
        feature: null,
        note_uk: 'База даних недоступна. Геометрію тимчасово не можна отримати.',
      };
    }

    const result = await this.databaseService.query<RegionFeatureRow>(
      `
        SELECT rc.uid,
               rc.title_uk,
               rc.region_type,
               rc.parent_uid,
               COALESCE(arc.status, ' ') AS status,
               ST_AsGeoJSON(rg.geom) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
        WHERE rc.uid = $1
          AND rc.is_active = TRUE
        LIMIT 1
      `,
      [uid],
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('Геометрію для вказаного регіону не знайдено.');
    }

    return {
      feature: {
        type: 'Feature',
        geometry: JSON.parse(row.geometry_json),
        properties: {
          uid: row.uid,
          title_uk: row.title_uk,
          region_type: row.region_type,
          parent_uid: row.parent_uid,
          status: row.status,
        },
      },
    };
  }

  async getUkraineBoundary() {
    if (!this.databaseService.isConfigured()) {
      return { feature: null };
    }

    const result = await this.databaseService.query<{ geom_json: string }>(
      `
        SELECT ST_AsGeoJSON(
          ST_MakeValid(
            ST_Union(ST_Simplify(rg.geom, 0.01))
          )
        ) AS geom_json
        FROM region_geometry rg
        JOIN region_catalog rc ON rc.uid = rg.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type = ANY($1::text[])
      `,
      [['oblast', 'city']],
    );

    const row = result.rows[0];
    if (!row?.geom_json) {
      return { feature: null };
    }

    return {
      feature: {
        type: 'Feature',
        geometry: JSON.parse(row.geom_json),
      },
    };
  }

  getConfig() {
    return {
      default_layer_id: 'osm-standard',
      layers: [
        {
          id: 'osm-standard',
          title_uk: 'OpenStreetMap',
          url_template: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution_uk: 'Мапа © OpenStreetMap contributors',
          min_zoom: 4,
          max_zoom: 19,
          subdomains: ['a', 'b', 'c'],
          is_default: true,
        },
        {
          id: 'carto-light',
          title_uk: 'Світла карта Carto',
          url_template: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          attribution_uk: 'Базова карта © OpenStreetMap contributors, © CARTO',
          min_zoom: 4,
          max_zoom: 20,
          subdomains: ['a', 'b', 'c', 'd'],
          is_default: false,
        },
        {
          id: 'opentopo',
          title_uk: 'Топографічна карта',
          url_template: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
          attribution_uk: 'Карта © OpenTopoMap, дані © OpenStreetMap contributors',
          min_zoom: 4,
          max_zoom: 17,
          subdomains: ['a', 'b', 'c'],
          is_default: false,
        },
      ],
      overlay_config: {
        min_zoom_by_layer: {
          oblast: 4,
          raion: 7,
          hromada: 10,
        },
        geometry_pack_versions: {
          oblast: GEOMETRY_PACK_VERSION,
          raion: GEOMETRY_PACK_VERSION,
          hromada: GEOMETRY_PACK_VERSION,
        },
      },
    };
  }

  async getFeatures(layer: string, bbox?: string, zoom?: number, packVersion?: string) {
    if (!this.databaseService.isConfigured()) {
      return {
        layer,
        bbox: bbox ?? null,
        zoom: zoom ?? null,
        pack_version: packVersion ?? GEOMETRY_PACK_VERSION,
        features: [],
        note_uk: 'База даних недоступна. GeoJSON-фічі тимчасово не можна отримати.',
      };
    }

    const selectedLod = this.resolveLod(layer, zoom);
    const parsedBbox = this.parseBbox(bbox);
    const cacheKey = CACHE_KEYS.FEATURES(layer, selectedLod) + (bbox ? `:${bbox}` : '');

    // Try cache first
    const cached = await this.cacheService.get<FeaturesBundleDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for features: ${cacheKey}`);
      const alertsBundle = await this.cacheService.get<AlertsBundleDto>(CACHE_KEYS.ALERTS_CURRENT);
      this.mapBundleService.mergeAlertsStatus(cached, alertsBundle);
      return {
        layer,
        bbox: bbox ?? null,
        zoom: zoom ?? null,
        pack_version: packVersion ?? GEOMETRY_PACK_VERSION,
        features: this.buildFeaturesFromBundle(cached),
      };
    }

    // Cache miss - build bundle
    this.logger.debug(`Cache miss for features: ${cacheKey}`);
    const bundle = await this.mapBundleService.buildFeaturesBundle(layer, selectedLod, parsedBbox ?? undefined);

    // Merge alerts status
    const alertsBundle = await this.cacheService.get<AlertsBundleDto>(CACHE_KEYS.ALERTS_CURRENT);
    this.mapBundleService.mergeAlertsStatus(bundle, alertsBundle);

    // Cache the bundle
    await this.cacheService.set(cacheKey, bundle, CACHE_TTL.FEATURES);

    return {
      layer,
      bbox: bbox ?? null,
      zoom: zoom ?? null,
      pack_version: packVersion ?? GEOMETRY_PACK_VERSION,
      features: this.buildFeaturesFromBundle(bundle),
    };
  }

  private buildFeaturesFromBundle(bundle: FeaturesBundleDto) {
    return bundle.features.geometries.map((geom) => {
      const status = bundle.features.status_lookup[geom.uid];
      return {
        type: 'Feature',
        geometry: geom.geometry,
        properties: {
          uid: geom.uid,
          title_uk: geom.title_uk,
          region_type: geom.region_type,
          parent_uid: geom.parent_uid,
          oblast_uid: geom.oblast_uid,
          status: status?.status ?? ' ',
          alert_type: status?.alert_type ?? 'air_raid',
        },
      };
    });
  }

  async getActiveAlerts() {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        features: [],
        note_uk: 'База даних недоступна.',
      };
    }

    // Try to get from cache first
    const cached = await this.cacheService.get<AlertsBundleDto>(CACHE_KEYS.ALERTS_CURRENT);
    if (cached) {
      this.logger.debug(`Cache hit for alerts: state_version=${cached.state_version}`);
      return {
        generated_at: cached.generated_at,
        features: cached.active_alerts.features.map((f) => ({
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            uid: f.uid,
            title_uk: f.title_uk,
            region_type: f.region_type,
            alert_type: f.alert_type,
          },
        })),
      };
    }

    // Cache miss - fall back to database query
    this.logger.debug('Cache miss for alerts, querying database');
    const result = await this.databaseService.query<ActiveAlertRow>(
      `
        SELECT rc.uid,
               rc.title_uk,
               rc.region_type,
               COALESCE(arc.alert_type, 'air_raid') AS alert_type,
               ST_AsGeoJSON(
                 COALESCE(
                   rgl.geom,
                   ST_Simplify(rg.geom, 0.01)
                 )
               ) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
        JOIN air_raid_state_current arc ON arc.uid = rc.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type IN ('raion', 'hromada')
          AND arc.status = 'A'
        ORDER BY rc.region_type DESC, rc.uid ASC
      `,
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geometry_json),
        properties: {
          uid: row.uid,
          title_uk: row.title_uk,
          region_type: row.region_type,
          alert_type: row.alert_type,
        },
      })),
    };
  }

  async getActiveAlertsSimplified() {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        features: [],
        note_uk: 'База даних недоступна.',
      };
    }

    const result = await this.databaseService.query<{
      uid: number;
      title_uk: string;
      region_type: string;
      alert_type: string;
      geometry_json: string;
    }>(
      `
        SELECT rc.uid,
               rc.title_uk,
               rc.region_type,
               COALESCE(arc.alert_type, 'air_raid') AS alert_type,
               ST_AsGeoJSON(COALESCE(rgl.geom, ST_Simplify(rg.geom, 0.005))) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
        JOIN air_raid_state_current arc ON arc.uid = rc.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type = 'raion'
          AND arc.status = 'A'
        ORDER BY rc.uid ASC
      `,
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geometry_json),
        properties: {
          uid: row.uid,
          title_uk: row.title_uk,
          region_type: row.region_type,
          alert_type: row.alert_type,
        },
      })),
    };
  }

  async getAlertsLayer() {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        features: [],
        note_uk: 'База даних недоступна.',
      };
    }

    const result = await this.databaseService.query<{
      uid: number;
      region_type: string;
      alert_type: string;
      geometry_json: string;
      updated_at: string;
    }>(
      `
        SELECT uid,
               region_type,
               alert_type,
               geometry_json,
               updated_at
        FROM alert_layer_features
        ORDER BY
          CASE region_type
            WHEN 'oblast' THEN 1
            WHEN 'city' THEN 2
            WHEN 'raion' THEN 3
            WHEN 'hromada' THEN 4
            ELSE 5
          END,
          uid ASC
      `,
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geometry_json),
        properties: {
          uid: row.uid,
          region_type: row.region_type,
          alert_type: row.alert_type,
        },
      })),
      updated_at: result.rows[0]?.updated_at,
    };
  }

  async getThreatOverlays(bbox?: string) {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        overlays: [],
        note_uk: 'База даних недоступна. Шар загроз тимчасово не можна отримати.',
      };
    }

    // Try cache first for non-bbox requests (full map)
    const cacheKey = bbox ? `threats:${bbox}` : CACHE_KEYS.THREATS_BUCKET(Date.now());
    const cached = await this.cacheService.get<any>(cacheKey);
    if (cached && !bbox) {
      this.logger.debug(`Cache hit for threats: bucket=${cached.bucket_ts}`);
      return {
        generated_at: cached.generated_at,
        overlays: cached.overlays,
      };
    }

    const parsedBbox = this.parseBbox(bbox);
    const values: unknown[] = [];
    let bboxClause = '';

    if (parsedBbox) {
      values.push(parsedBbox.west, parsedBbox.south, parsedBbox.east, parsedBbox.north);
      bboxClause = `
        AND (
          (tv.target_geom IS NOT NULL AND tv.target_geom && ST_MakeEnvelope($1, $2, $3, $4, 4326))
          OR (tv.origin_geom IS NOT NULL AND tv.origin_geom && ST_MakeEnvelope($1, $2, $3, $4, 4326))
          OR (tv.danger_area_geom IS NOT NULL AND tv.danger_area_geom && ST_MakeEnvelope($1, $2, $3, $4, 4326))
        )
      `;
    }

    const result = await this.databaseService.query<ThreatOverlayRow>(
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
               ST_AsGeoJSON(COALESCE(tv.origin_geom, tv.target_geom)) AS marker_json,
               ST_AsGeoJSON(tv.corridor_geom) AS corridor_json,
               ST_AsGeoJSON(tv.danger_area_geom) AS area_json
        FROM threat_visual_overlays tvo
        JOIN threat_vectors tv ON tv.vector_id = tvo.vector_id
        LEFT JOIN telegram_messages_raw tmr ON tmr.raw_message_id = tv.raw_message_id
        LEFT JOIN region_catalog rc_anchor ON rc_anchor.uid = COALESCE(tv.target_uid, tv.origin_uid)
        LEFT JOIN LATERAL (
          SELECT e.occurred_at AS first_ended_at
          FROM air_raid_events e
          WHERE e.uid = COALESCE(rc_anchor.raion_uid, rc_anchor.uid)
            AND e.event_kind = 'ended'
            AND e.occurred_at >= tv.occurred_at
          ORDER BY e.occurred_at ASC
          LIMIT 1
        ) ended_since_occurrence ON TRUE
        LEFT JOIN air_raid_state_current arc_raion
          ON arc_raion.uid = COALESCE(rc_anchor.raion_uid, rc_anchor.uid)
        WHERE tvo.status = 'active'
          AND (
            -- Threats with region anchoring (target_uid or origin_uid): check alert status
            (
              COALESCE(tv.target_uid, tv.origin_uid) IS NOT NULL
              AND tv.occurred_at + ${THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL} > NOW()
              AND (
                -- Alert hasn't ended yet
                ended_since_occurrence.first_ended_at IS NULL
                -- Or alert ended recently (within grace period)
                OR tv.occurred_at + ${THREAT_OVERLAY_ENDED_GRACE_PERIOD_SQL} > NOW()
              )
              AND (
                -- Alert is still active in the region
                arc_raion.status IN ('A', 'P')
                -- Or threat is recent enough (pending alert interval)
                OR tv.occurred_at + ${THREAT_OVERLAY_PENDING_ALERT_INTERVAL_SQL} > NOW()
              )
            )
            -- Threats WITHOUT region anchoring (e.g., Black Sea threats): show based on expiry only
            OR (
              COALESCE(tv.target_uid, tv.origin_uid) IS NULL
              AND COALESCE(tv.expires_at, tv.occurred_at + ${THREAT_OVERLAY_MAX_VISIBLE_INTERVAL_SQL}) > NOW()
            )
          )
          ${bboxClause}
        ORDER BY tvo.render_priority ASC, tv.occurred_at DESC
      `,
      values,
    );

    const overlays = result.rows.map((row) => {
      const marker = row.marker_json ? JSON.parse(row.marker_json) : null;
      const corridor = row.corridor_json ? JSON.parse(row.corridor_json) : null;
      const area = row.area_json ? JSON.parse(row.area_json) : null;

      return {
        overlay_id: row.overlay_id,
        vector_id: row.vector_id,
        threat_kind: row.threat_kind,
        confidence: Number(row.confidence),
        movement_bearing_deg: this.resolveOverlayBearing(row.movement_bearing_deg, corridor),
        icon_type: row.icon_type,
        color_hex: row.color_hex,
        occurred_at: row.occurred_at,
        expires_at: row.expires_at,
        message_text: row.message_text,
        message_date: row.message_date,
        marker,
        corridor,
        area,
      };
    });

    // Cache non-bbox requests
    if (!bbox && overlays.length > 0) {
      const bucketTs = Math.floor(Date.now() / 300000) * 300000;
      const bundle = {
        bucket_ts: bucketTs,
        generated_at: TimeUtil.getNowInKyiv(),
        overlays: overlays,
      };
      await this.cacheService.set(CACHE_KEYS.THREATS_BUCKET(Date.now()), bundle, CACHE_TTL.THREATS);
    }

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      overlays: overlays,
    };
  }

  private resolveOverlayBearing(storedBearing: number | null, corridor: unknown) {
    return resolveMovementBearingDegrees(storedBearing, this.getCorridorBearing(corridor));
  }

  private getCorridorBearing(corridor: unknown) {
    if (!corridor || typeof corridor !== 'object') {
      return null;
    }

    const maybeLineString = corridor as { type?: string; coordinates?: unknown };
    if (maybeLineString.type !== 'LineString' || !Array.isArray(maybeLineString.coordinates)) {
      return null;
    }

    const coordinates = maybeLineString.coordinates;
    if (coordinates.length < 2) {
      return null;
    }

    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    if (!Array.isArray(start) || !Array.isArray(end) || start.length < 2 || end.length < 2) {
      return null;
    }

    const [startLng, startLat, endLng, endLat] = [start[0], start[1], end[0], end[1]].map((value) => Number(value));
    if (![startLat, startLng, endLat, endLng].every((value) => Number.isFinite(value))) {
      return null;
    }

    return calculateBearingDegrees(startLat, startLng, endLat, endLng);
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
        throw new BadRequestException('Невідомий шар карти. Дозволено лише oblast, raion або hromada.');
    }
  }

  private resolveLod(layer: string, zoom?: number) {
    if (layer === 'oblast') {
      return zoom !== undefined && zoom >= 7 ? 'medium' : 'low';
    }

    if (layer === 'raion') {
      return zoom !== undefined && zoom >= 10 ? 'high' : 'medium';
    }

    return zoom !== undefined && zoom >= 12 ? 'high' : 'medium';
  }

  private parseBbox(bbox?: string) {
    if (!bbox) {
      return null;
    }

    const parts = bbox
      .split(',')
      .map((value) => Number(value.trim()));

    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      throw new BadRequestException('Параметр bbox має бути у форматі west,south,east,north.');
    }

    const [west, south, east, north] = parts;
    return { west, south, east, north };
  }

  async getSimplifiedOblastMap() {
    if (!this.databaseService.isConfigured()) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        oblasts: [],
        note_uk: 'База даних недоступна. Спрощену карту тимчасово не можна отримати.',
      };
    }

    const result = await this.databaseService.query<{
      uid: number;
      title_uk: string;
      status: 'A' | 'P' | 'N' | ' ';
      alert_type: string;
      geometry_json: string;
      center_lon: number;
      center_lat: number;
      bounds_west: number;
      bounds_south: number;
      bounds_east: number;
      bounds_north: number;
    }>(
      `
        SELECT rc.uid,
               rc.title_uk,
               COALESCE(arc.status, 'N') AS status,
               COALESCE(arc.alert_type, 'air_raid') AS alert_type,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(rg.geom, 0.01)) AS geometry_json,
               ST_X(rg.centroid) AS center_lon,
               ST_Y(rg.centroid) AS center_lat,
               ST_XMin(rg.bbox) AS bounds_west,
               ST_YMin(rg.bbox) AS bounds_south,
               ST_XMax(rg.bbox) AS bounds_east,
               ST_YMax(rg.bbox) AS bounds_north
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
        WHERE rc.is_active = TRUE
          AND rc.region_type = 'oblast'
        ORDER BY rc.uid ASC
      `,
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      oblasts: result.rows.map((row) => ({
        uid: row.uid,
        title_uk: row.title_uk,
        status: row.status,
        alert_type: row.alert_type,
        geometry: JSON.parse(row.geometry_json),
        center: { lat: row.center_lat, lon: row.center_lon },
        bounds: {
          west: row.bounds_west,
          south: row.bounds_south,
          east: row.bounds_east,
          north: row.bounds_north,
        },
      })),
    };
  }

  async archiveOldThreats(): Promise<number> {
    if (!this.databaseService.isConfigured()) {
      this.logger.warn('Database not configured, skipping archive operation');
      return 0;
    }

    const result = await this.databaseService.query<{ archive_old_threat_overlays: number }>(
      `SELECT archive_old_threat_overlays() as archived_count;`
    );

    const archivedCount = result.rows[0]?.archived_count || 0;

    if (archivedCount > 0) {
      this.logger.log(`Archived ${archivedCount} old threat overlays`);
    }

    return archivedCount;
  }

}
