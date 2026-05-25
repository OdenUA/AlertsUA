#!/usr/bin/env tsx
/**
 * Скрипт для загрузки актуальных данных об оккупированных территориях
 * из репозитория DeepStateMap (GitHub Action обновляет ежедневно)
 *
 * Использование: npm run fetch:occupied
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data';
const OUTPUT_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'occupied-territories.geojson');

interface GeoJSONFeatureCollection {
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

/**
 * Получает сегодняшнюю дату в формате YYYYMMDD
 */
function getTodayFileName(): string {
  const now = new Date();
  // Используем UTC, чтобы избежать проблем с часовыми поясами
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `deepstatemap_data_${year}${month}${day}.geojson`;
}

/**
 * Загружает файл по HTTPS
 */
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Основная функция
 */
async function main() {
  console.log('📥 Загрузка данных об оккупированных территориях...');

  // Убедимся, что директория существует
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`📁 Создана директория: ${OUTPUT_DIR}`);
  }

  const fileName = getTodayFileName();
  const url = `${GITHUB_RAW_BASE}/${fileName}`;

  console.log(`🌐 Загрузка: ${url}`);

  try {
    const data = await fetchUrl(url);
    const geojson: GeoJSONFeatureCollection = JSON.parse(data);

    // Валидация структуры
    if (geojson.type !== 'FeatureCollection') {
      throw new Error('Некорректный формат GeoJSON: ожидается FeatureCollection');
    }

    if (!geojson.features || geojson.features.length === 0) {
      throw new Error('GeoJSON не содержит features');
    }

    console.log(`✅ Загружен файл: ${geojson.name}`);
    console.log(`📊 Features: ${geojson.features.length}`);
    console.log(`📍 CRS: ${geojson.crs?.properties?.name || 'не указан'}`);

    // Сохраняем файл
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(geojson, null, 2), 'utf8');
    console.log(`💾 Сохранено: ${OUTPUT_FILE}`);

    // Статистика по координатам
    const feature = geojson.features[0];
    if (feature.geometry.type === 'MultiPolygon') {
      const polygonCount = feature.geometry.coordinates.length;
      console.log(`🔷 Полигонов: ${polygonCount}`);
    }

    return {
      success: true,
      file: OUTPUT_FILE,
      name: geojson.name,
      features: geojson.features.length
    };

  } catch (error) {
    // Если файл за сегодня не найден, пробуем вчерашний
    if (error instanceof Error && error.message.includes('404')) {
      console.log('⚠️ Файл за сегодня не найден, пробуем вчерашний...');

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const year = yesterday.getUTCFullYear();
      const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
      const day = String(yesterday.getUTCDate()).padStart(2, '0');
      const yesterdayFileName = `deepstatemap_data_${year}${month}${day}.geojson`;
      const yesterdayUrl = `${GITHUB_RAW_BASE}/${yesterdayFileName}`;

      console.log(`🌐 Загрузка: ${yesterdayUrl}`);

      try {
        const data = await fetchUrl(yesterdayUrl);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(JSON.parse(data), null, 2), 'utf8');
        console.log(`💾 Сохранено: ${OUTPUT_FILE} (вчерашние данные)`);
        return { success: true, file: OUTPUT_FILE, backup: true };
      } catch (retryError) {
        throw new Error(`Не удалось загрузить данные: ${(retryError as Error).message}`);
      }
    }

    throw error;
  }
}

// Запуск
main()
  .then(result => {
    console.log('✅ Готово!');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Ошибка:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
