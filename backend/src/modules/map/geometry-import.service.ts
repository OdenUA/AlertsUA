import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdir, readFile, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';

type RegionType = 'oblast' | 'raion' | 'hromada' | 'city';

type CatalogRow = {
  uid: number;
  region_type: RegionType;
  title_uk: string;
  parent_uid: number | null;
  oblast_uid: number | null;
  raion_uid: number | null;
};

type GeoFeature = {
  type: 'Feature';
  properties: Record<string, string | number | null>;
  geometry: unknown;
};

type GeoJsonCollection = {
  type: 'FeatureCollection';
  features: GeoFeature[];
};

type MatchedGeometry = {
  uid: number;
  source_layer: 'admin1' | 'admin2' | 'admin3';
  source_name_uk: string;
  geometry_json: string;
  source_geometry_hash: string;
};

const execFileAsync = promisify(execFile);

const OCHA_BOUNDARIES_URL =
  'https://data.humdata.org/dataset/d23f529f-31e4-4021-a65b-13987e5cfb42/resource/681beb86-391b-4a08-8140-ca52e80fcdce/download/ukr_admin_boundaries.geojson.zip';
const OCHA_VERSION = 'ocha-cod-ab-v05';
const DEFAULT_SOURCE_ROOT = '/srv/alerts-ua/data/geo/source/ocha-cod-ab';
const DEFAULT_ZIP_PATH = `${DEFAULT_SOURCE_ROOT}/ukr_admin_boundaries.geojson.zip`;
const DEFAULT_EXTRACT_DIR = `${DEFAULT_SOURCE_ROOT}/extracted`;
const LODS: Array<{ lod: 'low' | 'medium' | 'high'; simplification_meters: number }> = [
  { lod: 'low', simplification_meters: 1500 },
  { lod: 'medium', simplification_meters: 500 },
  { lod: 'high', simplification_meters: 0 },
];

@Injectable()
export class GeometryImportService {
  constructor(private readonly databaseService: DatabaseService) {}

  async importOchaBoundaries(options?: {
    zipPath?: string;
    extractDir?: string;
    refreshDownload?: boolean;
    skipDownload?: boolean;
  }) {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const zipPath = options?.zipPath ?? DEFAULT_ZIP_PATH;
    const extractDir = options?.extractDir ?? DEFAULT_EXTRACT_DIR;

    await mkdir(extractDir, { recursive: true });
    await mkdir(DEFAULT_SOURCE_ROOT, { recursive: true });

    if (!options?.skipDownload) {
      const shouldDownload = options?.refreshDownload || !(await this.pathExists(zipPath));
      if (shouldDownload) {
        await execFileAsync('curl', ['-fsSL', OCHA_BOUNDARIES_URL, '-o', zipPath]);
      }
    }

    if (!(await this.pathExists(zipPath))) {
      throw new Error(`GeoJSON archive was not found at ${zipPath}.`);
    }

    await execFileAsync('unzip', ['-o', zipPath, '-d', extractDir]);

    const admin1 = await this.readGeoJson(`${extractDir}/ukr_admin1.geojson`);
    const admin2 = await this.readGeoJson(`${extractDir}/ukr_admin2.geojson`);
    const admin3 = await this.readGeoJson(`${extractDir}/ukr_admin3.geojson`);

    const fileStats = await stat(zipPath);
    const catalogRows = await this.loadCatalogRows();
    const matchReport = this.matchFeatures(catalogRows, { admin1, admin2, admin3 });

    await this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
          DELETE FROM region_geometry_lod
          WHERE uid IN (
            SELECT uid
            FROM region_catalog
            WHERE region_type IN ('oblast', 'raion', 'hromada', 'city')
          )
        `,
      );
      await client.query(
        `
          DELETE FROM region_geometry
          WHERE uid IN (
            SELECT uid
            FROM region_catalog
            WHERE region_type IN ('oblast', 'raion', 'hromada', 'city')
          )
        `,
      );

      for (const feature of matchReport.matched) {
        await this.upsertGeometry(client, feature);
        for (const lod of LODS) {
          await this.upsertGeometryLod(client, feature, lod.lod, lod.simplification_meters);
        }
      }
    });

    return {
      source_url: OCHA_BOUNDARIES_URL,
      source_version: `${OCHA_VERSION}:${fileStats.mtime.toISOString()}`,
      zip_path: zipPath,
      extract_dir: extractDir,
      matched_total: matchReport.matched.length,
      matched_by_layer: matchReport.matchedByLayer,
      unmatched_by_layer: matchReport.unmatchedByLayer,
      unmatched_samples: matchReport.unmatchedSamples,
    };
  }

  private async loadCatalogRows() {
    const result = await this.databaseService.query<CatalogRow>(
      `
        SELECT uid, region_type, title_uk, parent_uid, oblast_uid, raion_uid
        FROM region_catalog
        WHERE is_active = TRUE
          AND region_type IN ('oblast', 'raion', 'hromada', 'city')
        ORDER BY uid ASC
      `,
    );

    return result.rows;
  }

  private matchFeatures(
    catalogRows: CatalogRow[],
    layers: {
      admin1: GeoJsonCollection;
      admin2: GeoJsonCollection;
      admin3: GeoJsonCollection;
    },
  ) {
    const oblastByKey = new Map<string, CatalogRow[]>();
    const cityByKey = new Map<string, CatalogRow[]>();
    const raionByKey = new Map<string, CatalogRow[]>();
    const hromadaByKey = new Map<string, CatalogRow[]>();

    for (const row of catalogRows) {
      const normalized = this.normalizeCatalogTitle(row.title_uk, row.region_type);
      const targetMap =
        row.region_type === 'oblast'
          ? oblastByKey
          : row.region_type === 'city'
            ? cityByKey
            : row.region_type === 'raion'
              ? raionByKey
              : hromadaByKey;

      const bucket = targetMap.get(normalized) ?? [];
      bucket.push(row);
      targetMap.set(normalized, bucket);
    }

    const matched: MatchedGeometry[] = [];
    const admin1UidByName = new Map<string, number>();
    const admin2UidByKey = new Map<string, number>();
    const unmatchedByLayer = { admin1: 0, admin2: 0, admin3: 0 };
    const unmatchedSamples = { admin1: [] as string[], admin2: [] as string[], admin3: [] as string[] };

    for (const feature of layers.admin1.features) {
      const sourceName = String(feature.properties.adm1_name1 ?? '').trim();
      const match = this.matchAdmin1(sourceName, oblastByKey, cityByKey);
      if (!match) {
        unmatchedByLayer.admin1 += 1;
        if (unmatchedSamples.admin1.length < 20) {
          unmatchedSamples.admin1.push(sourceName);
        }
        continue;
      }

      admin1UidByName.set(String(feature.properties.adm1_pcode ?? ''), match.uid);
      matched.push(this.buildMatchedGeometry(match.uid, 'admin1', sourceName, feature.geometry));
    }

    for (const feature of layers.admin2.features) {
      const sourceName = String(feature.properties.adm2_name1 ?? '').trim();
      const oblastUid = admin1UidByName.get(String(feature.properties.adm1_pcode ?? '')) ?? null;
      const normalized = this.normalizeSourceName(sourceName, 'raion');
      const candidates = (raionByKey.get(normalized) ?? []).filter(
        (row) => oblastUid === null || row.oblast_uid === oblastUid,
      );

      if (candidates.length !== 1) {
        unmatchedByLayer.admin2 += 1;
        if (unmatchedSamples.admin2.length < 20) {
          unmatchedSamples.admin2.push(`${sourceName} | oblast_uid=${oblastUid ?? 'null'}`);
        }
        continue;
      }

      const matchedRow = candidates[0];
      admin2UidByKey.set(String(feature.properties.adm2_pcode ?? ''), matchedRow.uid);
      matched.push(this.buildMatchedGeometry(matchedRow.uid, 'admin2', sourceName, feature.geometry));
    }

    for (const feature of layers.admin3.features) {
      const sourceName = String(feature.properties.adm3_name1 ?? '').trim();
      const oldName = String(feature.properties.adm3_name1_old ?? '').trim() || null;
      const raionUid = admin2UidByKey.get(String(feature.properties.adm2_pcode ?? '')) ?? null;
      const oblastUid = admin1UidByName.get(String(feature.properties.adm1_pcode ?? '')) ?? null;
      const match = this.matchAdmin3(sourceName, oldName, hromadaByKey, raionUid, oblastUid);

      if (!match) {
        unmatchedByLayer.admin3 += 1;
        if (unmatchedSamples.admin3.length < 20) {
          unmatchedSamples.admin3.push(`${sourceName} | raion_uid=${raionUid ?? 'null'}`);
        }
        continue;
      }

      matched.push(this.buildMatchedGeometry(match.uid, 'admin3', sourceName, feature.geometry));
    }

    return {
      matched,
      matchedByLayer: {
        admin1: matched.filter((row) => row.source_layer === 'admin1').length,
        admin2: matched.filter((row) => row.source_layer === 'admin2').length,
        admin3: matched.filter((row) => row.source_layer === 'admin3').length,
      },
      unmatchedByLayer,
      unmatchedSamples,
    };
  }

  private matchAdmin1(
    sourceName: string,
    oblastByKey: Map<string, CatalogRow[]>,
    cityByKey: Map<string, CatalogRow[]>,
  ) {
    const oblastMatches = oblastByKey.get(this.normalizeSourceName(sourceName, 'oblast')) ?? [];
    if (oblastMatches.length === 1) {
      return oblastMatches[0];
    }

    const cityMatches = cityByKey.get(this.normalizeSourceName(sourceName, 'city')) ?? [];
    if (cityMatches.length === 1) {
      return cityMatches[0];
    }

    return null;
  }

  private matchAdmin3(
    sourceName: string,
    oldName: string | null,
    hromadaByKey: Map<string, CatalogRow[]>,
    raionUid: number | null,
    oblastUid: number | null,
  ) {
    const keys = [sourceName, oldName]
      .filter((value): value is string => Boolean(value))
      .map((value) => this.normalizeSourceName(value, 'hromada'));

    for (const key of keys) {
      const matches = (hromadaByKey.get(key) ?? []).filter(
        (row) => (raionUid === null || row.raion_uid === raionUid) &&
          (oblastUid === null || row.oblast_uid === oblastUid),
      );

      if (matches.length === 1) {
        return matches[0];
      }
    }

    return null;
  }

  private buildMatchedGeometry(
    uid: number,
    sourceLayer: 'admin1' | 'admin2' | 'admin3',
    sourceNameUk: string,
    geometry: unknown,
  ): MatchedGeometry {
    const geometryJson = JSON.stringify(geometry);
    return {
      uid,
      source_layer: sourceLayer,
      source_name_uk: sourceNameUk,
      geometry_json: geometryJson,
      source_geometry_hash: createHash('sha256')
        .update(`${sourceLayer}:${sourceNameUk}:${geometryJson}`)
        .digest('hex'),
    };
  }

  private normalizeCatalogTitle(value: string, regionType: RegionType) {
    let text = this.normalizeUk(value);

    if (regionType === 'oblast') {
      return text.replace(/\s+область$/, '').trim();
    }

    if (regionType === 'city') {
      return text.replace(/^м\.\s*/, '').trim();
    }

    if (regionType === 'raion') {
      return text.replace(/\s+район$/, '').trim();
    }

    return text
      .replace(/^м\.\s*.+?\s+та\s+/, '')
      .replace(/\s+територіальна\s+громада$/, '')
      .replace(/\s+громада$/, '')
      .trim();
  }

  private normalizeSourceName(value: string, regionType: RegionType) {
    return this.normalizeCatalogTitle(value, regionType);
  }

  private normalizeUk(value: string) {
    return value
      .toLowerCase()
      .replace(/[’ʼ`]/g, "'")
      .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async upsertGeometry(client: PoolClient, feature: MatchedGeometry) {
    await client.query(
      `
        INSERT INTO region_geometry (
          uid,
          geom,
          centroid,
          bbox,
          source_geometry_hash,
          updated_at
        ) VALUES (
          $1,
          ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($2)), 4326),
          ST_PointOnSurface(ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($2)), 4326)),
          ST_Envelope(ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($2)), 4326)),
          $3,
          NOW()
        )
        ON CONFLICT (uid) DO UPDATE SET
          geom = EXCLUDED.geom,
          centroid = EXCLUDED.centroid,
          bbox = EXCLUDED.bbox,
          source_geometry_hash = EXCLUDED.source_geometry_hash,
          updated_at = NOW()
      `,
      [feature.uid, feature.geometry_json, feature.source_geometry_hash],
    );
  }

  private async upsertGeometryLod(
    client: PoolClient,
    feature: MatchedGeometry,
    lod: 'low' | 'medium' | 'high',
    simplificationMeters: number,
  ) {
    await client.query(
      `
        INSERT INTO region_geometry_lod (
          uid,
          lod,
          geom,
          simplification_meters,
          updated_at
        ) VALUES (
          $1,
          $2,
          CASE
            WHEN $4 = 0 THEN ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($3)), 4326)
            ELSE ST_Multi(
              ST_CollectionExtract(
                ST_Transform(
                  ST_SimplifyPreserveTopology(
                    ST_Transform(ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($3)), 4326), 3857),
                    $4
                  ),
                  4326
                ),
                3
              )
            )
          END,
          $4,
          NOW()
        )
        ON CONFLICT (uid, lod) DO UPDATE SET
          geom = EXCLUDED.geom,
          simplification_meters = EXCLUDED.simplification_meters,
          updated_at = NOW()
      `,
      [feature.uid, lod, feature.geometry_json, simplificationMeters],
    );
  }

  private async readGeoJson(filePath: string) {
    const fileContent = await readFile(filePath, 'utf8');
    return JSON.parse(fileContent) as GeoJsonCollection;
  }

  private async pathExists(path: string) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}