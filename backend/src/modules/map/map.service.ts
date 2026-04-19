import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

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
const UAV_POST_ALERT_GRACE_INTERVAL_SQL = "INTERVAL '1 hour'";

@Injectable()
export class MapService {
  constructor(private readonly databaseService: DatabaseService) {}

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

    const regionTypes = this.resolveLayerRegionTypes(layer);
    const selectedLod = this.resolveLod(layer, zoom);
    const parsedBbox = this.parseBbox(bbox);
    const values: unknown[] = [regionTypes, selectedLod];
    let bboxClause = '';

    if (parsedBbox) {
      values.push(parsedBbox.west, parsedBbox.south, parsedBbox.east, parsedBbox.north);
      bboxClause = `
        AND COALESCE(rgl.geom, rg.geom) && ST_MakeEnvelope($3, $4, $5, $6, 4326)
        AND ST_Intersects(COALESCE(rgl.geom, rg.geom), ST_MakeEnvelope($3, $4, $5, $6, 4326))
      `;
    }

    const result = await this.databaseService.query<MapFeatureRow>(
      `
        WITH base AS (
          SELECT rc.uid,
                 rc.title_uk,
                 rc.region_type,
                 rc.parent_uid,
                 rc.oblast_uid,
                 COALESCE(arc.status, ' ') AS raw_status,
                 COALESCE(arc.alert_type, 'air_raid') AS alert_type,
                 ST_AsGeoJSON(COALESCE(rgl.geom, rg.geom)) AS geometry_json
          FROM region_catalog rc
          JOIN region_geometry rg ON rg.uid = rc.uid
          LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = $2
          LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
          WHERE rc.is_active = TRUE
            AND rc.region_type = ANY($1::text[])
            ${bboxClause}
        ),
        coverage AS (
          SELECT
            b.uid,
            COUNT(leaf.uid)::int AS total_leaf_count,
            COUNT(*) FILTER (WHERE leaf_state.status = 'A')::int AS active_leaf_count
          FROM base b
          JOIN region_catalog leaf ON leaf.is_active = TRUE
            AND leaf.is_subscription_leaf = TRUE
            AND (
              (b.region_type = 'oblast' AND leaf.oblast_uid = b.uid)
              OR
              (b.region_type = 'raion' AND leaf.raion_uid = b.uid)
            )
          LEFT JOIN air_raid_state_current leaf_state ON leaf_state.uid = leaf.uid
          WHERE b.region_type IN ('oblast', 'raion')
          GROUP BY b.uid
        )
        SELECT b.uid,
               b.title_uk,
               b.region_type,
               b.parent_uid,
               b.oblast_uid,
               CASE
                 WHEN b.region_type IN ('oblast', 'raion') AND c.total_leaf_count > 0 THEN
                   CASE
                     WHEN c.active_leaf_count = 0 THEN 'N'
                     WHEN c.active_leaf_count = c.total_leaf_count THEN 'A'
                     ELSE 'P'
                   END
                 ELSE b.raw_status
               END AS status,
               b.alert_type,
               b.geometry_json
        FROM base b
        LEFT JOIN coverage c ON c.uid = b.uid
        ORDER BY b.uid ASC
      `,
      values,
    );

    return {
      layer,
      bbox: bbox ?? null,
      zoom: zoom ?? null,
      pack_version: packVersion ?? GEOMETRY_PACK_VERSION,
      features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geometry_json),
        properties: {
          uid: row.uid,
          title_uk: row.title_uk,
          region_type: row.region_type,
          parent_uid: row.parent_uid,
          oblast_uid: row.oblast_uid,
          status: row.status,
          alert_type: row.alert_type,
        },
      })),
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
               ST_AsGeoJSON(COALESCE(tv.target_geom, tv.origin_geom)) AS marker_json,
               ST_AsGeoJSON(tv.corridor_geom) AS corridor_json,
               ST_AsGeoJSON(tv.danger_area_geom) AS area_json
        FROM threat_visual_overlays tvo
        JOIN threat_vectors tv ON tv.vector_id = tvo.vector_id
        LEFT JOIN telegram_messages_raw tmr ON tmr.raw_message_id = tv.raw_message_id
        LEFT JOIN region_catalog rc_anchor ON rc_anchor.uid = COALESCE(tv.target_uid, tv.origin_uid)
        LEFT JOIN LATERAL (
          SELECT e.occurred_at AS last_ended_at
          FROM air_raid_events e
          WHERE e.uid = COALESCE(rc_anchor.raion_uid, rc_anchor.uid)
            AND e.event_kind = 'ended'
          ORDER BY e.occurred_at DESC
          LIMIT 1
        ) last_end ON TRUE
        LEFT JOIN air_raid_state_current arc_raion
          ON arc_raion.uid = COALESCE(rc_anchor.raion_uid, rc_anchor.uid)
        WHERE tvo.status = 'active'
          AND (
            (
              COALESCE(tv.target_uid, tv.origin_uid) IS NOT NULL
              AND (tv.expires_at IS NULL OR tv.expires_at > NOW())
              AND (
                arc_raion.status IN ('A', 'P')
                OR (
                  tv.threat_kind = 'uav'
                  AND last_end.last_ended_at IS NOT NULL
                  AND last_end.last_ended_at + ${UAV_POST_ALERT_GRACE_INTERVAL_SQL} > NOW()
                )
              )
            )
            OR (
              COALESCE(tv.target_uid, tv.origin_uid) IS NULL
              AND (tv.expires_at IS NULL OR tv.expires_at > NOW())
            )
          )
          ${bboxClause}
        ORDER BY tvo.render_priority ASC, tv.occurred_at DESC
      `,
      values,
    );

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      overlays: result.rows.map((row) => ({
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
        marker: row.marker_json ? JSON.parse(row.marker_json) : null,
        corridor: row.corridor_json ? JSON.parse(row.corridor_json) : null,
        area: row.area_json ? JSON.parse(row.area_json) : null,
      })),
    };
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

}
