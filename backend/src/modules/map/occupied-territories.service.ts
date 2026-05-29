import { Injectable, Logger } from '@nestjs/common';
import { TimeUtil } from '../../common/utils/time.util';
import fs from 'fs';
import path from 'path';

export interface OccupiedTerritoriesGeoJSON {
  type: 'FeatureCollection';
  name: string;
  crs: {
    type: 'name';
    properties: { name: string };
  };
  features: Array<{
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: {
      type: 'MultiPolygon' | 'Polygon';
      coordinates: number[][][] | number[][][][];
    };
  }>;
}

// Try multiple paths to find occupied territories data file:
// 1. Release-local data/ (current working directory)
// 2. Shared app-level data/ directory (survives deploy rotations)
function resolveOccupiedTerritoriesPath(): string {
  const cwdPath = path.join(process.cwd(), 'data', 'occupied-territories.geojson');
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }
  // Fallback: shared app data directory (outside release directories)
  // Structure: /srv/alerts-ua/app/current/ -> ../data/ = /srv/alerts-ua/app/data/
  const appDataPath = path.join(process.cwd(), '..', 'data', 'occupied-territories.geojson');
  if (fs.existsSync(appDataPath)) {
    return appDataPath;
  }
  // Last fallback: two levels up
  const parentPath = path.join(process.cwd(), '..', '..', 'data', 'occupied-territories.geojson');
  return parentPath;
}

const OCCUPIED_TERRITORIES_FILE = resolveOccupiedTerritoriesPath();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

@Injectable()
export class OccupiedTerritoriesService {
  private readonly logger = new Logger(OccupiedTerritoriesService.name);
  private cache: {
    data: OccupiedTerritoriesGeoJSON | null;
    loadedAt: number | null;
    fileModifiedAt: string | null;
  } = {
    data: null,
    loadedAt: null,
    fileModifiedAt: null,
  };

  /**
   * Возвращает GeoJSON с границами оккупированных территорий
   */
  async getOccupiedTerrories(): Promise<{
    geojson: OccupiedTerritoriesGeoJSON | null;
    meta: {
      loaded_at: string | null;
      file_modified_at: string | null;
      is_cached: boolean;
      note_uk: string;
    };
  }> {
    const now = Date.now();

    // Проверяем, есть ли файл
    if (!fs.existsSync(OCCUPIED_TERRITORIES_FILE)) {
      this.logger.warn('Occupied territories file not found');
      return {
        geojson: null,
        meta: {
          loaded_at: null,
          file_modified_at: null,
          is_cached: false,
          note_uk: 'Файл з даними про окуповані території не знайдено. Запустіть npm run fetch:occupied',
        },
      };
    }

    // Получаем информацию о файле
    const stats = fs.statSync(OCCUPIED_TERRITORIES_FILE);
    const fileModifiedAt = stats.mtime.toISOString();

    // Проверяем кеш
    if (
      this.cache.data &&
      this.cache.loadedAt &&
      now - this.cache.loadedAt < CACHE_TTL_MS &&
      this.cache.fileModifiedAt === fileModifiedAt
    ) {
      this.logger.debug('Returning cached occupied territories data');
      return {
        geojson: this.cache.data,
        meta: {
          loaded_at: new Date(this.cache.loadedAt).toISOString(),
          file_modified_at: fileModifiedAt,
          is_cached: true,
          note_uk: 'Дані з кешу',
        },
      };
    }

    // Загружаем данные из файла
    try {
      const rawContent = fs.readFileSync(OCCUPIED_TERRITORIES_FILE, 'utf8');
      const data: OccupiedTerritoriesGeoJSON = JSON.parse(rawContent);

      // Валидация базовой структуры
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error('Invalid GeoJSON format');
      }

      // Обновляем кеш
      this.cache = {
        data,
        loadedAt: now,
        fileModifiedAt,
      };

      this.logger.log(`Loaded occupied territories: ${data.features.length} features from ${data.name}`);

      return {
        geojson: data,
        meta: {
          loaded_at: new Date(now).toISOString(),
          file_modified_at: fileModifiedAt,
          is_cached: false,
          note_uk: `Завантажено з файлу: ${data.name}`,
        },
      };
    } catch (error) {
      this.logger.error('Failed to load occupied territories file', error instanceof Error ? error.message : error);
      return {
        geojson: null,
        meta: {
          loaded_at: null,
          file_modified_at: fileModifiedAt,
          is_cached: false,
          note_uk: 'Помилка читання файлу з даними',
        },
      };
    }
  }

  /**
   * Возвращает упрощенную версию для отображения на карте
   */
  async getOccupiedTerroriesLayer() {
    const result = await this.getOccupiedTerrories();

    if (!result.geojson) {
      return {
        generated_at: TimeUtil.getNowInKyiv(),
        feature: null,
        meta: result.meta,
      };
    }

    return {
      generated_at: TimeUtil.getNowInKyiv(),
      feature: result.geojson.features[0] || null,
      meta: result.meta,
    };
  }

  /**
   * Проверяет, находится ли точка внутри оккупированной территории
   */
  async isPointOccupied(lat: number, lon: number): Promise<{
    is_occupied: boolean;
    meta: {
      checked_at: string;
      note_uk: string;
    };
  }> {
    // Для точной проверки нужен PostGIS
    // Возвращаем заглушку, которая указывает на необходимость загрузки данных
    const result = await this.getOccupiedTerrories();

    if (!result.geojson) {
      return {
        is_occupied: false,
        meta: {
          checked_at: TimeUtil.getNowInKyiv(),
          note_uk: 'Дані про окуповані території недоступні',
        },
      };
    }

    // TODO: Реализовать проверку точки внутри MultiPolygon
    // Это потребует либо turf.js, либо PostGIS
    return {
      is_occupied: false,
      meta: {
        checked_at: TimeUtil.getNowInKyiv(),
        note_uk: 'Перевірка точки ще не реалізована',
      },
    };
  }

  /**
   * Сбрасывает кеш
   */
  clearCache() {
    this.cache = {
      data: null,
      loadedAt: null,
      fileModifiedAt: null,
    };
    this.logger.log('Cache cleared');
  }
}
