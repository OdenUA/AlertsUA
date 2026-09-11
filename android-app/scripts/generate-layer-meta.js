#!/usr/bin/env node
// Генерирует assets/map/data/layer-meta.json — компактный индекс
// uid → {t: title_uk, r: region_type, c: [centerLon, centerLat]} (bbox-центр).
// Нужен нативной карте, чтобы не парсить большие GeoJSON в объектный граф:
// геометрия отдаётся в GeoJsonSource строкой (нативный парс), а центры/названия
// берутся из этого файла. Запуск: node android-app/scripts/generate-layer-meta.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'map', 'data');

function bboxCenter(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      if (node[0] < minLon) minLon = node[0];
      if (node[0] > maxLon) maxLon = node[0];
      if (node[1] < minLat) minLat = node[1];
      if (node[1] > maxLat) maxLat = node[1];
      return;
    }
    node.forEach(walk);
  };
  walk(geometry && geometry.coordinates);
  if (!Number.isFinite(minLon)) return null;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return [round((minLon + maxLon) / 2), round((minLat + maxLat) / 2)];
}

const meta = {};
for (const layer of ['oblast', 'raion', 'hromada']) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${layer}.geojson`), 'utf8'));
  const entries = {};
  for (const f of raw.features) {
    const p = f.properties || {};
    if (p.uid === undefined || p.uid === null) continue;
    const entry = { c: bboxCenter(f.geometry) };
    // Название/тип нужны только для oblast-слоя (поиск Киева и его области)
    if (layer === 'oblast') {
      entry.t = p.title_uk || '';
      entry.r = p.region_type || '';
    }
    entries[String(p.uid)] = entry;
  }
  meta[layer] = entries;
  console.log(`${layer}: ${Object.keys(entries).length} entries`);
}

const out = path.join(DATA_DIR, 'layer-meta.json');
fs.writeFileSync(out, JSON.stringify(meta));
console.log('written:', out, fs.statSync(out).size, 'bytes');
