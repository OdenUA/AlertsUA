import { Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { readFile, stat } from 'fs/promises';
import type { PoolClient } from 'pg';
import { resolve } from 'path';
import { DatabaseService } from '../../common/database/database.service';
import { SupabaseSyncService } from '../supabase/supabase-sync.service';
import { TimeUtil } from '../../common/utils/time.util';

type RegionType = 'oblast' | 'raion' | 'city' | 'hromada' | 'unknown';

type ParsedRegionRow = {
  row_number: number;
  uid: number;
  title_uk: string;
  region_type: RegionType;
  notes: string | null;
  parent_uid: number | null;
  oblast_uid: number | null;
  raion_uid: number | null;
  source_sheet: string;
  source_row_hash: string;
  is_subscription_leaf: boolean;
};

const KNOWN_RAION_OBLAST_OVERRIDES: Readonly<Record<number, number>> = {
  38: 8,
  39: 8,
  40: 8,
  41: 8,
};

@Injectable()
export class ImportsService {
  constructor(
    @Optional() private readonly databaseService?: DatabaseService,
    @Optional() private readonly supabaseSyncService?: SupabaseSyncService,
  ) {}

  async inspectWorkbook(filePath?: string) {
    const parsedWorkbook = await this.parseWorkbook(filePath);
    const sampleRows = parsedWorkbook.rows.slice(0, 8);

    return {
      source_path: parsedWorkbook.source_path,
      source_version: parsedWorkbook.source_version,
      workbook_hash: parsedWorkbook.workbook_hash,
      sheet_names: parsedWorkbook.sheet_names,
      detected_header_row: parsedWorkbook.detected_header_row,
      headers: parsedWorkbook.headers,
      total_rows: parsedWorkbook.rows.length,
      sample_rows: sampleRows,
    };
  }

  async importWorkbook(filePath?: string) {
    if (!this.databaseService) {
      throw new Error('DatabaseService is not available in this execution context.');
    }

    const parsedWorkbook = await this.parseWorkbook(filePath);
    const importId = randomUUID();
    const syncTimestamp = TimeUtil.getNowInKyiv();

    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO region_import_runs (
            import_id,
            source_kind,
            source_path,
            source_version,
            workbook_hash,
            sheet_names,
            started_at,
            status,
            rows_total,
            rows_inserted,
            rows_updated,
            rows_skipped
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() AT TIME ZONE 'Europe/Kyiv', 'running', $7, 0, 0, 0)
        `,
        [
          importId,
          'xlsx_snapshot',
          parsedWorkbook.source_path,
          parsedWorkbook.source_version,
          parsedWorkbook.workbook_hash,
          JSON.stringify(parsedWorkbook.sheet_names),
          parsedWorkbook.rows.length,
        ],
      );

      let rowsInserted = 0;
      let rowsUpdated = 0;
      let rowsSkipped = 0;

      for (const row of parsedWorkbook.rows) {
        const existing = await client.query<{ uid: number }>(
          'SELECT uid FROM region_catalog WHERE uid = $1',
          [row.uid],
        );

        if (existing.rowCount === 0) {
          rowsInserted += 1;
        } else {
          rowsUpdated += 1;
        }

        await this.upsertRegion(client, parsedWorkbook, row);

        if (this.supabaseSyncService) {
          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'regions_ref',
            entity_id: row.uid,
            operation: existing.rowCount === 0 ? 'insert' : 'update',
            payload: {
              uid: row.uid,
              region_type: row.region_type,
              title_uk: row.title_uk,
              parent_uid: row.parent_uid,
              oblast_uid: row.oblast_uid,
              raion_uid: row.raion_uid,
              source_version: parsedWorkbook.source_version,
              updated_at: syncTimestamp,
            },
          });
        }
      }

      await client.query(
        `
          UPDATE region_import_runs
          SET finished_at = NOW() AT TIME ZONE 'Europe/Kyiv',
              status = 'succeeded',
              rows_inserted = $2,
              rows_updated = $3,
              rows_skipped = $4
          WHERE import_id = $1
        `,
        [importId, rowsInserted, rowsUpdated, rowsSkipped],
      );

      return {
        import_id: importId,
        source_path: parsedWorkbook.source_path,
        source_version: parsedWorkbook.source_version,
        workbook_hash: parsedWorkbook.workbook_hash,
        rows_total: parsedWorkbook.rows.length,
        rows_inserted: rowsInserted,
        rows_updated: rowsUpdated,
        rows_skipped: rowsSkipped,
      };
    });
  }

  private async parseWorkbook(filePath?: string) {
    const workbook = new ExcelJS.Workbook();
    const targetPath = resolve(filePath ?? '..\\alerts.in.ua _ Райони, області, громади.xlsx');
    const fileBuffer = await readFile(targetPath);
    const fileStats = await stat(targetPath);
    const workbookHash = createHash('sha256').update(fileBuffer).digest('hex');
    await workbook.xlsx.readFile(targetPath);

    const worksheet = workbook.worksheets[0];
    const headerRowNumber = 4;
    const headerRow = worksheet.getRow(headerRowNumber);
    const headers = {
      uid: this.normalizeCellValue(headerRow.getCell(1).value),
      title_uk: this.normalizeCellValue(headerRow.getCell(2).value),
      region_type: this.normalizeCellValue(headerRow.getCell(3).value),
      notes: this.normalizeCellValue(headerRow.getCell(4).value),
    };

    let currentOblastUid: number | null = null;
    let currentRaionUid: number | null = null;
    let currentRaionOblastUid: number | null = null;
    const parsedRows: ParsedRegionRow[] = [];

    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const uidRaw = this.normalizeCellValue(row.getCell(1).value);
      const titleRaw = this.normalizeCellValue(row.getCell(2).value);
      const typeRaw = this.normalizeCellValue(row.getCell(3).value);
      const notesRaw = this.normalizeCellValue(row.getCell(4).value);

      if (uidRaw === null && titleRaw === null && typeRaw === null) {
        continue;
      }

      const uid = this.normalizeUid(uidRaw);
      const titleUk = typeof titleRaw === 'string' ? titleRaw.trim() : null;
      const regionType = this.normalizeRegionType(typeRaw);
      const notes = typeof notesRaw === 'string' ? notesRaw.trim() || null : null;

      if (!uid || !titleUk) {
        continue;
      }

      let parentUid: number | null = null;
      let oblastUid: number | null = null;
      let raionUid: number | null = currentRaionUid;

      switch (regionType) {
        case 'oblast':
          currentOblastUid = uid;
          currentRaionUid = null;
          currentRaionOblastUid = null;
          parentUid = null;
          oblastUid = uid;
          raionUid = null;
          break;
        case 'raion': {
          const resolvedOblastUid = this.resolveRaionOblastUid(uid, currentOblastUid);
          parentUid = resolvedOblastUid;
          oblastUid = resolvedOblastUid;
          currentRaionUid = uid;
          currentRaionOblastUid = resolvedOblastUid;
          raionUid = uid;
          break;
        }
        case 'hromada':
          parentUid = currentRaionUid;
          oblastUid = currentRaionOblastUid;
          raionUid = currentRaionUid;
          break;
        case 'city':
          parentUid = null;
          oblastUid = null;
          raionUid = null;
          currentRaionUid = null;
          currentRaionOblastUid = null;
          break;
        default:
          parentUid = currentRaionUid;
          oblastUid = currentRaionOblastUid;
          raionUid = currentRaionUid;
          break;
      }

      parsedRows.push({
        row_number: rowNumber,
        uid,
        title_uk: titleUk,
        region_type: regionType,
        notes,
        parent_uid: parentUid,
        oblast_uid: oblastUid,
        raion_uid: raionUid,
        source_sheet: worksheet.name,
        source_row_hash: this.hashRow(uid, titleUk, regionType, notes),
        is_subscription_leaf: regionType === 'hromada' || regionType === 'city',
      });
    }

    return {
      source_path: targetPath,
      source_version: `xlsx:${fileStats.mtime.toISOString()}:${workbookHash.slice(0, 12)}`,
      workbook_hash: workbookHash,
      sheet_names: workbook.worksheets.map((sheet) => sheet.name),
      detected_header_row: headerRowNumber,
      headers,
      rows: parsedRows,
    };
  }

  private async upsertRegion(
    client: PoolClient,
    parsedWorkbook: {
      source_path: string;
      source_version: string;
    },
    row: ParsedRegionRow,
  ) {
    await client.query(
      `
        INSERT INTO region_catalog (
          uid,
          region_type,
          title_uk,
          parent_uid,
          oblast_uid,
          raion_uid,
          source_kind,
          source_path,
          source_sheet,
          source_row_hash,
          source_version,
          is_subscription_leaf,
          is_active,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          'xlsx_snapshot',
          $7, $8, $9, $10, $11,
          TRUE,
          NOW() AT TIME ZONE 'Europe/Kyiv',
          NOW() AT TIME ZONE 'Europe/Kyiv'
        )
        ON CONFLICT (uid) DO UPDATE SET
          region_type = EXCLUDED.region_type,
          title_uk = EXCLUDED.title_uk,
          parent_uid = EXCLUDED.parent_uid,
          oblast_uid = EXCLUDED.oblast_uid,
          raion_uid = EXCLUDED.raion_uid,
          source_kind = EXCLUDED.source_kind,
          source_path = EXCLUDED.source_path,
          source_sheet = EXCLUDED.source_sheet,
          source_row_hash = EXCLUDED.source_row_hash,
          source_version = EXCLUDED.source_version,
          is_subscription_leaf = EXCLUDED.is_subscription_leaf,
          is_active = EXCLUDED.is_active,
          updated_at = NOW() AT TIME ZONE 'Europe/Kyiv'
      `,
      [
        row.uid,
        row.region_type,
        row.title_uk,
        row.parent_uid,
        row.oblast_uid,
        row.raion_uid,
        parsedWorkbook.source_path,
        row.source_sheet,
        row.source_row_hash,
        parsedWorkbook.source_version,
        row.is_subscription_leaf,
      ],
    );
  }

  private normalizeCellValue(value: ExcelJS.CellValue): string | number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }

    if (typeof value === 'object' && 'result' in value) {
      const result = value.result;
      if (typeof result === 'string' || typeof result === 'number') {
        return result;
      }
    }

    if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
      return value.text;
    }

    return String(value);
  }

  private normalizeUid(value: string | number | null) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.trunc(value) : null;
    }

    if (typeof value === 'string') {
      const normalized = Number(value.replace(',', '.'));
      return Number.isFinite(normalized) ? Math.trunc(normalized) : null;
    }

    return null;
  }

  private normalizeRegionType(value: string | number | null): RegionType {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    switch (normalized) {
      case 'область':
        return 'oblast';
      case 'район':
        return 'raion';
      case 'громада':
        return 'hromada';
      case 'місто з спеціальним статусом':
        return 'city';
      default:
        return 'unknown';
    }
  }

  private resolveRaionOblastUid(raionUid: number, currentOblastUid: number | null) {
    if (currentOblastUid === 29 && raionUid in KNOWN_RAION_OBLAST_OVERRIDES) {
      return KNOWN_RAION_OBLAST_OVERRIDES[raionUid] ?? currentOblastUid;
    }

    return currentOblastUid;
  }

  private hashRow(uid: number, titleUk: string, regionType: RegionType, notes: string | null) {
    return createHash('sha256')
      .update(JSON.stringify({ uid, titleUk, regionType, notes }))
      .digest('hex');
  }
}
