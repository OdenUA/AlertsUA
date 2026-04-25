import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';
import type { FeaturesBundleDto } from '../../common/cache/dto/cache-bundle.dto';

type FeatureGeometryRow = {
  uid: number;
  title_uk: string;
  region_type: string;
  parent_uid: number | null;
  oblast_uid: number | null;
  geometry_json: string;
};

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

    // Do NOT merge oblast aggregates into status_lookup
    // Oblast aggregates are only used for the oblast layer display
    // Individual regions (raion/hromada) should only show their own alert status
    // This prevents oblast-level "A" status from coloring all sub-regions

    bundle.features.status_lookup = statusMap;
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
