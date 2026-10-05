#!/usr/bin/env python3
"""Округляет координаты в geojson-слоях карты до 5 знаков (~1 м).

Исходники из бэкенда несут 9 знаков (~0.1 мм) — бессмысленная точность
для отображения (max zoom карты 11 ≈ 49 м/px), которая раздувает assets
и замедляет чтение/парсинг на холодном старте. Скрипт идемпотентен.

Использование (после обновления geojson из бэкенда, ДО generate-layer-meta.js):
    python android-app/scripts/round-geojson-coords.py
"""

import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "app" / "src" / "main" / "assets" / "map" / "data"
LAYERS = ["oblast.geojson", "raion.geojson", "hromada.geojson"]
DECIMALS = 5


def round_coords(node):
    if isinstance(node, list):
        if node and all(isinstance(v, (int, float)) for v in node):
            return [round(float(v), DECIMALS) for v in node]
        return [round_coords(child) for child in node]
    return node


def main():
    for name in LAYERS:
        path = DATA_DIR / name
        doc = json.loads(path.read_text(encoding="utf-8"))
        before = path.stat().st_size
        for feature in doc.get("features", []):
            geometry = feature.get("geometry")
            if geometry:
                geometry["coordinates"] = round_coords(geometry["coordinates"])
        text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
        path.write_text(text, encoding="utf-8")
        after = path.stat().st_size
        print(f"{name}: {before} -> {after} bytes ({100 * after // max(before, 1)}%)")


if __name__ == "__main__":
    sys.exit(main())
