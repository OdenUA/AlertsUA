// Map initialization, overlays loading and runtime wiring

// Create map and status element (must run after DOM elements exist)
statusElement = document.getElementById('status');
map = L.map('map', {
    zoomControl: true,
    preferCanvas: true,
    attributionControl: true,
    scrollWheelZoom: true,
}).setView([49.0, 31.0], 7);

map.getContainer().tabIndex = 0;
map.on('mouseover', function () {
    map.getContainer().focus();
});
map.scrollWheelZoom.enable();
L.DomEvent.disableScrollPropagation(map.getContainer());
map.getContainer().addEventListener('wheel', function (event) {
    // Keep wheel interactions inside the map: zoom map instead of scrolling outer page.
    event.preventDefault();
}, { passive: false });

map.attributionControl.setPrefix(false);

function getFeaturePixelBox(featureLayer) {
    var bounds = featureLayer.getBounds();
    if (!bounds || !bounds.isValid()) {
        return null;
    }

    var northWest = map.latLngToContainerPoint(bounds.getNorthWest());
    var southEast = map.latLngToContainerPoint(bounds.getSouthEast());
    return {
        width: Math.abs(southEast.x - northWest.x),
        height: Math.abs(southEast.y - northWest.y),
    };
}

function getMarkerSizeForFeature(featureLayer) {
    var pixelBox = getFeaturePixelBox(featureLayer);
    if (!pixelBox) {
        return 0;
    }

    var minSide = Math.min(pixelBox.width, pixelBox.height);
    return Math.max(14, Math.min(30, Math.floor(minSide - 6)));
}

function refreshAlertMarkers() {
    if (alertMarkersLayer) {
        map.removeLayer(alertMarkersLayer);
        alertMarkersLayer = null;
    }
    alertMarkersLayer = L.layerGroup().addTo(map);

    if (!specialAlertLayer) {
        return;
    }

    specialAlertLayer.eachLayer(function(featureLayer) {
        var props = featureLayer.feature && featureLayer.feature.properties;
        if (!props || props.status !== 'A' || !isSpecialAlertType(props.alert_type)) {
            return;
        }

        var sizePx = getMarkerSizeForFeature(featureLayer);
        if (!sizePx) {
            return;
        }

        var center = featureLayer.getBounds().getCenter();
        var icon = makeAlertIcon(props.alert_type, sizePx);
        L.marker(center, { icon: icon, interactive: false, zIndexOffset: 700 })
            .addTo(alertMarkersLayer);
    });
}

function bringAlertLayersToFront() {
    if (overlayLayers.oblast) {
        overlayLayers.oblast.bringToFront();
    }
    if (overlayLayers.raion) {
        overlayLayers.raion.bringToFront();
    }
    if (overlayLayers.hromada) {
        overlayLayers.hromada.bringToFront();
    }
    if (specialAlertLayer) {
        specialAlertLayer.bringToFront();
    }
    if (alertMarkersLayer) {
        alertMarkersLayer.eachLayer(function(layer) {
            if (layer && layer.bringToFront) {
                layer.bringToFront();
            }
        });
    }
    if (threatOverlayLayer) {
        threatOverlayLayer.eachLayer(function(layer) {
            if (layer && layer.bringToFront) {
                layer.bringToFront();
            }
        });
    }
}

function refreshLayout() {
    window.requestAnimationFrame(() => {
        map.invalidateSize(false);
    });
}

function buildMaskFeature(ukraineGeometry) {
    // Outer ring covers the whole world; Ukraine polygon(s) become holes via evenodd fill rule.
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

        if (!maskFeature) {
            maskFeature = await collectOblastHoleRings();
        }

        if (!maskFeature) { return; }

        var isDark = document.body.classList.contains('dark');
        ukraineMaskLayer = L.geoJSON(maskFeature, {
            style: {
                fillColor:   isDark ? '#131e28' : '#e8f0f4',
                fillOpacity: 1.0,
                stroke:      hasBorder,
                color:       isDark ? '#2a4258' : '#91afc0',
                weight:      1.8,
            },
            interactive: false,
        }).addTo(map);
    } catch (_e) {
        // mask is optional — proceed without it
    }
}

window.setMapTheme = function (isDark) {
    document.body.classList.toggle('dark', isDark);
    if (tileLayer) {
        tileLayer.setOpacity(isDark ? 0.82 : 0.93);
    }
    if (ukraineMaskLayer) {
        ukraineMaskLayer.setStyle({
            fillColor:   isDark ? '#131e28' : '#e8f0f4',
            color:       isDark ? '#2a4258' : '#91afc0',
        });
    }

    if (mapReady) {
        scheduleOverlayRefresh();
    }
};

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
    const response = await fetch(buildUrl('/map/config'), {
        headers: {
            'Accept': 'application/json'
        }
    });

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

    tileLayer = L.tileLayer(defaultLayer.url_template, {
        attribution: defaultLayer.attribution_uk,
        minZoom: defaultLayer.min_zoom,
        maxZoom: defaultLayer.max_zoom,
        subdomains: defaultLayer.subdomains,
        opacity: 0.92,
    }).addTo(map);

    tileLayer.on('tileerror', function () {
        setStatus('Мапу відкрито. Якщо фон не видно, все одно можна вибрати місце.');
    });

    refreshLayout();
}

function getVisibleLayers() {
    if (!activeConfig || !activeConfig.overlay_config || !activeConfig.overlay_config.min_zoom_by_layer) {
        return ['oblast', 'raion'];
    }

    const zoom = map.getZoom();
    const thresholds = activeConfig.overlay_config.min_zoom_by_layer;
    const layers = ['oblast', 'raion'];

    if (zoom >= Number(thresholds.hromada || 10)) {
        layers.push('hromada');
    }

    return layers;
}

function formatBbox(bounds) {
    return [
        bounds.getWest().toFixed(6),
        bounds.getSouth().toFixed(6),
        bounds.getEast().toFixed(6),
        bounds.getNorth().toFixed(6)
    ].join(',');
}

function normalizeRegionTitle(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function isKyivCityFeature(feature) {
    var props = feature && feature.properties ? feature.properties : {};
    var title = normalizeRegionTitle(props.title_uk);
    return props.region_type === 'city'
        && (title === 'київ' || title === 'м. київ' || title === 'м київ');
}

function isKyivOblastFeature(feature) {
    var props = feature && feature.properties ? feature.properties : {};
    return props.region_type === 'oblast' && normalizeRegionTitle(props.title_uk) === 'київська область';
}

function applyKyivCityInheritedOblastState(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return features;
    }

    var kyivOblastFeature = features.find(isKyivOblastFeature);
    if (!kyivOblastFeature || !kyivOblastFeature.properties) {
        return features;
    }

    var oblastStatus = kyivOblastFeature.properties.status || ' ';
    var oblastAlertType = kyivOblastFeature.properties.alert_type || 'air_raid';

    features.forEach(function(feature) {
        if (!feature || !feature.properties || !isKyivCityFeature(feature)) {
            return;
        }

        feature.properties.inherited_oblast_status = oblastStatus;
        feature.properties.inherited_oblast_alert_type = oblastAlertType;
    });

    return features;
}

function featureStyle(feature, layerId) {
    const props = feature && feature.properties ? feature.properties : {};
    const status = props.status || ' ';
    const alertType = props.alert_type || 'air_raid';
    const baseAlertType = layerId === 'special' ? alertType : 'air_raid';
    const isActive  = status === 'A';
    const isPartial = status === 'P';
    const palette = getAlertPalette(baseAlertType);

    if (layerId === 'oblast' && isKyivCityFeature(feature)) {
        const inheritedStatus = props.inherited_oblast_status || ' ';
        const effectiveStatus = isActive ? status : inheritedStatus;

        if (effectiveStatus === 'A') {
            const effectiveAlertType = isActive
                ? alertType
                : (props.inherited_oblast_alert_type || 'air_raid');
            const effectivePalette = getAlertPalette(effectiveAlertType);

            return {
                stroke: false,
                fillColor: effectivePalette.fill,
                fillOpacity: effectivePalette.fillOpacity,
            };
        }

        return {
            stroke: false,
            fillColor: '#000000',
            fillOpacity: 0.001,
        };
    }

    // Hide borders for raion/hromada (requested), keep only alert fill.
    if (layerId === 'raion' || layerId === 'hromada') {
        return {
            stroke:      false,
            fillColor:   palette.fill,
            fillOpacity: isActive ? palette.fillOpacity : 0,
        };
    }

    if (layerId === 'special') {
        return {
            stroke:      false,
            fillColor:   palette.fill,
            fillOpacity: isActive ? palette.fillOpacity : 0,
        };
    }

    const weight = layerId === 'oblast' ? 2.5 : layerId === 'raion' ? 1.8 : 1.0;
    return {
        color:       (isActive || isPartial) ? palette.stroke : '#4d7a8a',
        weight:      weight,
        fillColor:   palette.fill,
        fillOpacity: isActive ? palette.fillOpacity : 0,
    };
}

function selectPoint(latlng) {
    if (window.AndroidBridge && window.AndroidBridge.onPointSelected) {
        window.AndroidBridge.onPointSelected(latlng.lat, latlng.lng);
    }
}

function bindFeatureTooltip(feature, layer) {
    layer.on('click', function (event) {
        if (event && event.latlng) {
            L.DomEvent.stopPropagation(event);
            selectPoint(event.latlng);
        }
    });
}

function fitToVisibleData() {
    if (hasFittedToData) {
        return;
    }

    const bounds = [];
    Object.values(overlayLayers).forEach((layer) => {
        if (layer && layer.getLayers && layer.getLayers().length > 0) {
            bounds.push(layer.getBounds());
        }
    });

    if (bounds.length === 0) {
        return;
    }

    let combinedBounds = bounds[0];
    for (let index = 1; index < bounds.length; index += 1) {
        combinedBounds = combinedBounds.extend(bounds[index]);
    }

    hasFittedToData = true;
    map.fitBounds(combinedBounds.pad(0.03), {
        animate: false,
    });
    map.setZoom(Math.min(map.getZoom() + INITIAL_FIT_ZOOM_STEP, map.getMaxZoom()), {
        animate: false,
    });
    refreshLayout();
}

async function loadLayer(layerId) {
    const packVersions = activeConfig && activeConfig.overlay_config
        ? activeConfig.overlay_config.geometry_pack_versions || {}
        : {};
    const response = await fetch(buildUrl('/map/features', {
        layer: layerId,
        zoom: map.getZoom(),
        pack_version: packVersions[layerId],
    }), {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Не вдалося оновити мапу.');
    }

    const data = await response.json();
    const features = data.features || [];
    if (layerId === 'oblast') {
        applyKyivCityInheritedOblastState(features);
    }

    const geoJsonLayer = L.geoJSON(features, {
        style: (feature) => featureStyle(feature, layerId),
        onEachFeature: bindFeatureTooltip,
    });

    if (overlayLayers[layerId]) {
        map.removeLayer(overlayLayers[layerId]);
    }

    overlayLayers[layerId] = geoJsonLayer.addTo(map);
}

async function loadSpecialAlertLayer() {
    const packVersions = activeConfig && activeConfig.overlay_config
        ? activeConfig.overlay_config.geometry_pack_versions || {}
        : {};
    const response = await fetch(buildUrl('/map/features', {
        layer: 'hromada',
        zoom: map.getZoom(),
        pack_version: packVersions.hromada,
    }), {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Не вдалося оновити спеціальні тривоги на мапі.');
    }

    const data = await response.json();
    const specialFeatures = (data.features || []).filter(function(feature) {
        var props = feature && feature.properties;
        return props && props.status === 'A' && isSpecialAlertType(props.alert_type);
    });

    const geoJsonLayer = L.geoJSON(specialFeatures, {
        style: function(feature) { return featureStyle(feature, 'special'); },
        onEachFeature: bindFeatureTooltip,
    });

    if (specialAlertLayer) {
        map.removeLayer(specialAlertLayer);
    }

    specialAlertLayer = geoJsonLayer.addTo(map);
}

async function refreshOverlays() {
    if (!activeConfig) {
        return;
    }

    const visibleLayers = getVisibleLayers();
    setStatus('Оновлюємо мапу…');

    await Promise.all(visibleLayers.map((layerId) => loadLayer(layerId)));
    await loadSpecialAlertLayer();
    await loadThreatOverlays();

    Object.keys(overlayLayers).forEach((layerId) => {
        if (!visibleLayers.includes(layerId) && overlayLayers[layerId]) {
            map.removeLayer(overlayLayers[layerId]);
            overlayLayers[layerId] = null;
        }
    });

    fitToVisibleData();
    refreshLayout();
    refreshAlertMarkers();
    bringAlertLayersToFront();
    setStatus(null);
}

function scheduleOverlayRefresh() {
    if (refreshTimerId) {
        window.clearTimeout(refreshTimerId);
    }

    refreshTimerId = window.setTimeout(() => {
        refreshOverlays().catch((error) => {
            console.error(error);
            setStatus(error.message || 'Не вдалося оновити мапу.');
        });
    }, 160);
}

function runWhenReady(fn) {
    if (mapReady) { fn(); } else { mapReadyQueue.push(fn); }
}

async function initializeMap() {
    mapReady = false;
    try {
        refreshLayout();
        await loadConfig();
        await loadUkraineMask();
        await refreshOverlays();
        mapReady = true;
        mapReadyQueue.forEach(function(fn) { fn(); });
        mapReadyQueue = [];
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Не вдалося відкрити мапу.');
    }
}

window.invalidateAlertsUaMap = function () {
    refreshLayout();
    window.setTimeout(refreshLayout, 120);
    window.setTimeout(refreshLayout, 420);
};

window.configureAlertsUa = function (nextApiBaseUrl) {
    if (!nextApiBaseUrl || typeof nextApiBaseUrl !== 'string') {
        return;
    }

    const normalizedUrl = nextApiBaseUrl.replace(/\/$/, '');
    if (normalizedUrl === apiBaseUrl) {
        refreshLayout();
        return;
    }

    apiBaseUrl = normalizedUrl;
    hasFittedToData = false;
    mapReady = false;
    mapReadyQueue = [];
    ukraineBoundaryGeometry = null;
    if (ukraineMaskLayer) {
        map.removeLayer(ukraineMaskLayer);
        ukraineMaskLayer = null;
    }
    if (specialAlertLayer) {
        map.removeLayer(specialAlertLayer);
        specialAlertLayer = null;
    }
    if (threatOverlayLayer) {
        map.removeLayer(threatOverlayLayer);
        threatOverlayLayer = null;
    }
    initializeMap();
};

function pointInRing(ring, x, y) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1];
        var xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInGeometry(lng, lat, geom) {
    if (!geom) { return false; }
    if (geom.type === 'Polygon') {
        if (!pointInRing(geom.coordinates[0], lng, lat)) { return false; }
        for (var h = 1; h < geom.coordinates.length; h++) {
            if (pointInRing(geom.coordinates[h], lng, lat)) { return false; }
        }
        return true;
    }
    if (geom.type === 'MultiPolygon') {
        return geom.coordinates.some(function(poly) {
            if (!pointInRing(poly[0], lng, lat)) { return false; }
            for (var h = 1; h < poly.length; h++) {
                if (pointInRing(poly[h], lng, lat)) { return false; }
            }
            return true;
        });
    }
    return false;
}

function isInsideUkraine(latlng) {
    if (ukraineBoundaryGeometry) {
        return pointInGeometry(latlng.lng, latlng.lat, ukraineBoundaryGeometry);
    }
    if (overlayLayers.oblast) {
        var found = false;
        overlayLayers.oblast.eachLayer(function(featureLayer) {
            if (found) { return; }
            if (featureLayer.feature && featureLayer.feature.geometry) {
                if (pointInGeometry(latlng.lng, latlng.lat, featureLayer.feature.geometry)) {
                    found = true;
                }
            }
        });
        return found;
    }
    return false;
}

window.addSubscriptionMarker = function(lat, lon, markerId) {
    runWhenReady(function() {
        if (subscriptionMarkers[markerId]) {
            map.removeLayer(subscriptionMarkers[markerId]);
        }
        var icon = L.divIcon({
            className: '',
            html: '<div class="sub-marker"></div>',
            iconSize: [28, 36],
            iconAnchor: [14, 36],
        });
        var id = markerId;
        var marker = L.marker([lat, lon], { icon: icon, zIndexOffset: 600 }).addTo(map);
        marker.on('click', function() {
            if (window.AndroidBridge && window.AndroidBridge.onSubscriptionMarkerTapped) {
                window.AndroidBridge.onSubscriptionMarkerTapped(id);
            }
        });
        subscriptionMarkers[id] = marker;
    });
};

window.removeSubscriptionMarker = function(markerId) {
    if (subscriptionMarkers[markerId]) {
        map.removeLayer(subscriptionMarkers[markerId]);
        delete subscriptionMarkers[markerId];
    }
};

window.restoreSubscriptionMarkers = function(markersList) {
    markersList.forEach(function(m) {
        window.addSubscriptionMarker(m.lat, m.lon, m.markerId);
    });
};

map.on('click', function (event) {
    if (!isInsideUkraine(event.latlng)) { return; }
    selectPoint(event.latlng);
});

map.on('zoomend', function () {
    if (!mapReady) {
        return;
    }

    refreshAlertMarkers();
    renderThreatOverlays();
    bringAlertLayersToFront();
});

window.addEventListener('resize', refreshLayout);

// Auto-refresh alert states every 30 seconds
setInterval(function () {
    if (!mapReady) { return; }
    refreshOverlays().catch(function (error) {
        console.warn('Auto-refresh failed:', error);
    });
}, 30000);

initializeMap();
