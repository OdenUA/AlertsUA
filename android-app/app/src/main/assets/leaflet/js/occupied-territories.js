/**
 * Оккупированные территории: красная граница + штриховая заливка
 * диагональными линиями того же цвета с повышенной непрозрачностью.
 *
 * Слои рисуются в отдельной pane (zIndex 450): над заливками и границами
 * областей (overlayPane = 400), но под маркерами (markerPane = 600),
 * поэтому не зависят от bringToFront и не перекрываются алерт-слоями.
 */

var occupiedHatchLayer = null; // canvas-слой штриховки (рядом с occupiedTerritoriesLayer)

var OCCUPIED_COLOR = '#dc2626';
var OCCUPIED_HATCH_SPACING_PX = 10;
var OCCUPIED_HATCH_OPACITY = 0.45;

function ensureOccupiedPane() {
    if (!map.getPane('occupiedPane')) {
        var pane = map.createPane('occupiedPane');
        pane.style.zIndex = '450';
        pane.style.pointerEvents = 'none';
    }
}

/** Итерирует все кольца всех полигонов Feature/FeatureCollection */
function forEachOccupiedRing(featureOrCollection, callback) {
    var features = featureOrCollection && featureOrCollection.type === 'FeatureCollection'
        ? featureOrCollection.features
        : [featureOrCollection];

    features.forEach(function (feature) {
        var geom = feature && feature.geometry;
        if (!geom) return;

        if (geom.type === 'Polygon') {
            geom.coordinates.forEach(callback);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(function (polygon) {
                polygon.forEach(callback);
            });
        }
    });
}

/**
 * Кастомный canvas-слой штриховки. Полигоны используются как clip-область,
 * внутри рисуются диагональные линии. Перерисовка — на moveend/zoomend/resize,
 * во время панорамирования canvas просто сдвигается (дешёво).
 */
var OccupiedHatchLayer = L.Layer.extend({
    onAdd: function (mapInstance) {
        this._map = mapInstance;
        var pane = mapInstance.getPane('occupiedPane');
        this._canvas = L.DomUtil.create('canvas', 'occupied-hatch-canvas', pane);
        this._canvas.style.position = 'absolute';
        mapInstance.on('move', this._reposition, this);
        mapInstance.on('moveend zoomend resize', this._redraw, this);
        this._redraw();
    },

    onRemove: function (mapInstance) {
        mapInstance.off('move', this._reposition, this);
        mapInstance.off('moveend zoomend resize', this._redraw, this);
        if (this._canvas && this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }
        this._canvas = null;
    },

    setFeature: function (feature) {
        this._feature = feature;
    },

    _reposition: function () {
        if (!this._canvas) return;
        var topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
    },

    _redraw: function () {
        var canvas = this._canvas;
        if (!canvas || !this._feature) return;

        var size = this._map.getSize();
        var topLeft = this._map.containerPointToLayerPoint([0, 0]);
        var dpr = window.devicePixelRatio || 1;

        canvas.width = Math.round(size.x * dpr);
        canvas.height = Math.round(size.y * dpr);
        canvas.style.width = size.x + 'px';
        canvas.style.height = size.y + 'px';
        L.DomUtil.setPosition(canvas, topLeft);

        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.x, size.y);

        // Path2D из полигонов в экранных координатах
        var path = new Path2D();
        var mapInstance = this._map;
        forEachOccupiedRing(this._feature, function (ring) {
            for (var i = 0; i < ring.length; i++) {
                var point = mapInstance.latLngToLayerPoint(L.latLng(ring[i][1], ring[i][0]));
                var x = point.x - topLeft.x;
                var y = point.y - topLeft.y;
                if (i === 0) { path.moveTo(x, y); } else { path.lineTo(x, y); }
            }
            path.closePath();
        });

        // Лёгкая базовая заливка для читаемости области
        var isDark = document.body.classList.contains('dark');
        ctx.fillStyle = 'rgba(220, 38, 38, ' + (isDark ? 0.08 : 0.05) + ')';
        ctx.fill(path);

        // Диагональная штриховка, обрезанная полигонами
        ctx.save();
        ctx.clip(path);
        ctx.strokeStyle = 'rgba(220, 38, 38, ' + OCCUPIED_HATCH_OPACITY + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var x = -size.y; x < size.x + size.y; x += OCCUPIED_HATCH_SPACING_PX) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x + size.y, size.y);
        }
        ctx.stroke();
        ctx.restore();
    },
});

/**
 * Рендерит границу и штриховку оккупированных территорий из feature.
 * Общая точка входа для оптимизированного и fallback-пути загрузки.
 */
function renderOccupiedTerritoriesFeature(feature) {
    if (!feature) return;

    ensureOccupiedPane();

    if (occupiedHatchLayer) {
        map.removeLayer(occupiedHatchLayer);
        occupiedHatchLayer = null;
    }
    if (occupiedTerritoriesLayer) {
        map.removeLayer(occupiedTerritoriesLayer);
        occupiedTerritoriesLayer = null;
    }

    // Порядок важен: штриховка первой — граница рисуется поверх неё
    occupiedHatchLayer = new OccupiedHatchLayer();
    occupiedHatchLayer.setFeature(feature);
    map.addLayer(occupiedHatchLayer);

    var isDark = document.body.classList.contains('dark');
    occupiedTerritoriesLayer = L.geoJSON(feature, {
        pane: 'occupiedPane',
        style: function () {
            return {
                stroke: true,
                color: OCCUPIED_COLOR,
                weight: 2.5,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
                fillColor: OCCUPIED_COLOR,
                fillOpacity: isDark ? 0.08 : 0.05,
                // Не интерактивный - клики проходят сквозь слой
                interactive: false
            };
        }
    }).addTo(map);
}

/**
 * Fallback-загрузка с сервера (используется вне оптимизированного пути).
 * Uses the occupiedTerritoriesLayer variable declared in constants.js.
 */
async function loadOccupiedTerritories() {
    debugLog('[OccupiedTerritories] Starting to load occupied territories...');

    let response;
    try {
        response = await fetch(buildUrl('/map/occupied-territories-layer'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('[OccupiedTerritories] Fetch error:', error);
        // Слой опциональный - продолжаем без него
        return;
    }

    if (!response.ok) {
        console.warn('[OccupiedTerritories] Failed to load:', response.status, response.statusText);
        return;
    }

    const data = await response.json();

    // Проверяем наличие feature
    if (!data.feature) {
        console.warn('[OccupiedTerritories] No feature data received');
        return;
    }

    debugLog('[OccupiedTerritories] Feature loaded:', data.feature.type);
    renderOccupiedTerritoriesFeature(data.feature);
}

/**
 * Обновляет стиль слоя оккупированных территорий при смене темы
 */
function updateOccupiedTerritoriesTheme() {
    var isDark = document.body.classList.contains('dark');

    if (occupiedTerritoriesLayer) {
        occupiedTerritoriesLayer.setStyle({
            fillColor: OCCUPIED_COLOR,
            fillOpacity: isDark ? 0.08 : 0.05
        });
    }

    // Штриховка зависит от темы через базовую заливку — перерисовываем
    if (occupiedHatchLayer) {
        occupiedHatchLayer._redraw();
    }
}
