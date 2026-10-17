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
// Перебираем ВСЕ существующие пути по порядку: если первый файл оказался
// битым (например, в него записали тело HTTP-ошибки), берём следующий.
function resolveOccupiedTerritoriesCandidates(): string[] {
  return [
    path.join(process.cwd(), 'data', 'occupied-territories.geojson'),
    // Fallback: shared app data directory (outside release directories)
    // Structure: /srv/alerts-ua/app/current/ -> ../data/ = /srv/alerts-ua/app/data/
    path.join(process.cwd(), '..', 'data', 'occupied-territories.geojson'),
    // Last fallback: two levels up
    path.join(process.cwd(), '..', '..', 'data', 'occupied-territories.geojson'),
  ];
}

const OCCUPIED_TERRITORIES_CANDIDATES = resolveOccupiedTerritoriesCandidates();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час
// При ошибке чтения не трогаем файл чаще, чем раз в 5 минут (пока mtime не изменился):
// иначе битый файл читается и парсится на КАЖДЫЙ запрос
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class OccupiedTerritoriesService {
  private readonly logger = new Logger(OccupiedTerritoriesService.name);
  private cache: {
    data: OccupiedTerritoriesGeoJSON | null;
    loadedAt: number | null;
    fileModifiedAt: string | null;
    filePath: string | null;
    failure: { failedAt: number; fileModifiedAt: string; filePath: string } | null;
  } = {
    data: null,
    loadedAt: null,
    fileModifiedAt: null,
    filePath: null,
    failure: null,
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

    for (const filePath of OCCUPIED_TERRITORIES_CANDIDATES) {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      // Получаем информацию о файле
      const stats = fs.statSync(filePath);
      const fileModifiedAt = stats.mtime.toISOString();

      // Negative cache: файл уже не читается — не гоняем read+parse чаще,
      // чем раз в NEGATIVE_CACHE_TTL_MS, пока файл не перезаписан (mtime тот же)
      if (
        this.cache.failure &&
        this.cache.failure.filePath === filePath &&
        this.cache.failure.fileModifiedAt === fileModifiedAt &&
        now - this.cache.failure.failedAt < NEGATIVE_CACHE_TTL_MS
      ) {
        return {
          geojson: null,
          meta: {
            loaded_at: null,
            file_modified_at: fileModifiedAt,
            is_cached: true,
            note_uk: 'Файл з даними пошкоджено, повторна спроба пізніше',
          },
        };
      }

      // Проверяем кеш
      if (
        this.cache.data &&
        this.cache.loadedAt &&
        now - this.cache.loadedAt < CACHE_TTL_MS &&
        this.cache.filePath === filePath &&
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
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const data: OccupiedTerritoriesGeoJSON = JSON.parse(rawContent);

        // Валидация базовой структуры (пустой features — тоже ошибка,
        // см. валидатор в fetch-occupied-territories.sh)
        if (
          data.type !== 'FeatureCollection' ||
          !Array.isArray(data.features) ||
          data.features.length === 0
        ) {
          throw new Error('Invalid GeoJSON format');
        }

        // Обновляем кеш
        this.cache = {
          data,
          loadedAt: now,
          fileModifiedAt,
          filePath,
          failure: null,
        };

        this.logger.log(`Loaded occupied territories: ${data.features.length} features from ${data.name} (${filePath})`);

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
        this.logger.error(
          `Failed to load occupied territories file: ${filePath}`,
          error instanceof Error ? error.message : error,
        );
        this.cache.failure = { failedAt: now, fileModifiedAt, filePath };
        // Файл битый — пробуем следующий путь-кандидат
      }
    }

    this.logger.warn('Occupied territories file not found in any known location');
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
      filePath: null,
      failure: null,
    };
    this.logger.log('Cache cleared');
  }
}
