function buildUrl(path, searchParams) {
    const url = new URL(apiBaseUrl.replace(/\/$/, '') + path);
    if (searchParams) {
        Object.entries(searchParams).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        });
    }
    return url.toString();
}

async function loadConfig() {
    setStatus('Завантажуємо мапу…');
    let response;
    try {
        response = await fetch(buildUrl('/map/config'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('Fetch error:', error);
        throw new Error('Не вдалося підключитися до сервера. Перевірте з\'єднання.');
    }

    if (!response.ok) {
        throw new Error('Не вдалося відкрити мапу.');
    }

    const config = await response.json();
    activeConfig = config;
    const defaultLayer = config.layers.find((layer) => layer.is_default) || config.layers[0];

    if (!defaultLayer) {
        throw new Error('Не вдалося підготувати мапу.');
    }

    if (tileLayer) {
        map.removeLayer(tileLayer);
    }

    // Create custom Ukraine tile layer to prevent loading tiles outside Ukraine
    var UkraineTileLayer = L.TileLayer.extend({
        createTile: function(coords, done) {
            // Convert tile coordinates to geographic bounds
            var tileBounds = this._tileCoordsToBounds(coords);

            // Check if tile intersects Ukraine area
            if (!this._tileIntersectsUkraine(tileBounds)) {
                // Return empty div instead of loading tile
                var tile = document.createElement('div');
                tile.className = 'leaflet-tile-loaded';
                done(null, tile);
                return tile;
            }

            // Standard tile loading
            return L.TileLayer.prototype.createTile.call(this, coords, done);
        },

        _tileIntersectsUkraine: function(tileBounds) {
            // Strict bounding box check - only within this exact rectangle
            var ukraineBounds = L.latLngBounds([[44.3, 22.1], [52.4, 40.2]]);
            return tileBounds.intersects(ukraineBounds);
        }
    });

    // Use custom Ukraine tile layer
    tileLayer = new UkraineTileLayer(defaultLayer.url_template, {
        attribution: defaultLayer.attribution_uk,
        minZoom: defaultLayer.min_zoom,
        maxZoom: defaultLayer.max_zoom,
        subdomains: defaultLayer.subdomains,
        opacity: 0.92,
        noWrap: true  // Prevent loading wrapped world tiles
    }).addTo(map);

    tileLayer.on('tileerror', function () {
        setStatus('Мапу відкрито. Якщо фон не видно, все одно можна вибрати місце.');
    });

    refreshLayout();
}

function buildMaskFeature(ukraineGeometry) {
    // Outer ring covers whole world; Ukraine polygon(s) become holes via evenodd fill rule.
    var worldRing = [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]];
    var holeRings = [];

    if (ukraineGeometry.type === 'Polygon') {
        holeRings.push(ukraineGeometry.coordinates[0]);
    } else if (ukraineGeometry.type === 'MultiPolygon') {
        ukraineGeometry.coordinates.forEach(function (polyCoords) {
            holeRings.push(polyCoords[0]);
        });
    }

    return {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [worldRing].concat(holeRings),
        },
    };
}

async function collectOblastHoleRings() {
    // Fetch oblast-level regions and extract their outer rings for use as holes in world mask.
    const response = await fetch(buildUrl('/map/features', { layer: 'oblast' }), {
        headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) { return null; }
    const data = await response.json();
    if (!data.features || !data.features.length) { return null; }

    const worldRing = [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]];
    const holeRings = [];
    data.features.forEach(function (feature) {
        var props = feature && feature.properties ? feature.properties : null;
        // Keep only oblast polygons in fallback mask construction.
        // The oblast endpoint can also include city polygons (e.g. Kyiv),
        // and nested holes would produce a grey filled "island" on map.
        if (!props || props.region_type !== 'oblast') { return; }

        var geom = feature.geometry;
        if (!geom) { return; }
        if (geom.type === 'Polygon') {
            holeRings.push(geom.coordinates[0]);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(function (polyCoords) { holeRings.push(polyCoords[0]); });
        }
    });
    if (!holeRings.length) { return null; }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [worldRing].concat(holeRings) } };
}

async function loadUkraineMask() {
    if (ukraineMaskLayer) {
        map.removeLayer(ukraineMaskLayer);
        ukraineMaskLayer = null;
    }

    try {
        var maskFeature = null;
        var hasBorder = false;

        // Prefer optimised union endpoint (available after backend deploy).
        const boundaryResp = await fetch(buildUrl('/map/ukraine-boundary'), {
            headers: { 'Accept': 'application/json' }
        });
        if (boundaryResp.ok) {
            const data = await boundaryResp.json();
            if (data.feature && data.feature.geometry) {
                ukraineBoundaryGeometry = data.feature.geometry;
                maskFeature = buildMaskFeature(data.feature.geometry);
                hasBorder = true;
            }
        }

        // Fallback: build mask from individual oblast features (no external dependency).
        if (!maskFeature) {
            maskFeature = await collectOblastHoleRings();
        }

        if (!maskFeature) { return; }

        // Используем CSS переменные для цвета заливки
        const computedStyle = getComputedStyle(document.body);
        const fillColor = computedStyle.getPropertyValue('--mask-fill').trim();
        const borderColor = computedStyle.getPropertyValue('--mask-border') || computedStyle.getPropertyValue('--mask-fill').trim();

        ukraineMaskLayer = L.geoJSON(maskFeature, {
            style: {
                fillColor:   fillColor,
                fillOpacity: 1.0,
                stroke:      hasBorder,
                color:       borderColor,
                weight:      1.8,
            },
            interactive: false,
        }).addTo(map);
    } catch (_e) {
        // mask is optional — proceed without it
    }
}

window.setMapTheme = function (isDark) {
    console.log('setMapTheme called with isDark:', isDark);
    document.body.classList.toggle('dark', isDark);
    if (tileLayer) {
        tileLayer.setOpacity(isDark ? 0.82 : 0.93);
    }
    if (ukraineMaskLayer) {
        // Используем CSS переменные для цвета заливки и границы
        const computedStyle = getComputedStyle(document.body);
        const fillColor = computedStyle.getPropertyValue('--mask-fill').trim();
        const borderColor = computedStyle.getPropertyValue('--mask-border').trim();

        ukraineMaskLayer.setStyle({
            fillColor:   fillColor,
            color:       borderColor,
        });
    }
    if (oblastBordersLayer) {
        oblastBordersLayer.setStyle({
            color: '#5a7d8e',
        });
    }

    // Принудительное обновление стилей кнопок зума
    const zoomControls = document.querySelectorAll('.leaflet-control-zoom a');
    console.log('Found zoom controls:', zoomControls.length);

    const computedStyle = getComputedStyle(document.body);
    const zoomBg = computedStyle.getPropertyValue('--zoom-bg').trim();
    const zoomColor = computedStyle.getPropertyValue('--zoom-color').trim();
    console.log('CSS variables - zoom-bg:', zoomBg, 'zoom-color:', zoomColor);

    zoomControls.forEach((control, index) => {
        console.log(`Control ${index}:`, control);
        // Прямое применение стилей
        control.style.backgroundColor = zoomBg;
        control.style.color = zoomColor;

        // Сбрасываем инлайновые стили Leaflet
        const originalBg = control.style.backgroundColor;
        const originalColor = control.style.color;

        // Даем браузеру время перерисоваться
        setTimeout(() => {
            control.style.backgroundColor = originalBg;
            control.style.color = originalColor;
        }, 50);
    });

    if (mapReady) {
        scheduleOverlayRefresh();
    }

    // Обновляем тему кастомных кнопок зума
    if (typeof updateCustomZoomTheme === 'function') {
        updateCustomZoomTheme();
    }
};

function refreshLayout() {
    window.requestAnimationFrame(() => {
        map.invalidateSize(false);
    });
}