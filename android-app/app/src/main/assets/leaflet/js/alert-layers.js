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
    // Oblast borders should be at the back (under alert fills)
    if (oblastBordersLayer) {
        oblastBordersLayer.bringToBack();
    }
    // Interactive regions layer (transparent, for clicks on non-alert areas)
    if (interactiveRegionsLayer) {
        interactiveRegionsLayer.bringToFront();
    }
    // Bring the precomputed alert layer to front
    if (alertLayersGroup) {
        alertLayersGroup.bringToFront();
    }
    // Special alert layer for special alert types
    if (specialAlertLayer) {
        specialAlertLayer.bringToFront();
    }
    // Alert markers (icons) should be on top
    if (alertMarkersLayer) {
        alertMarkersLayer.eachLayer(function(layer) {
            if (layer && layer.bringToFront) {
                layer.bringToFront();
            }
        });
    }
    // Threat overlays should be on top of everything
    if (threatOverlayLayer) {
        threatOverlayLayer.eachLayer(function(layer) {
            if (layer && layer.bringToFront) {
                layer.bringToFront();
            }
        });
    }
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
        fillOpacity: isActive ? palette.fillOpacity : 0,  // P = no fill; sub-regions show fill instead
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

    // Include threat overlays in auto-fit (important for threats from Black Sea, etc.)
    if (threatOverlayLayer && typeof threatOverlayLayer.getBounds === 'function' && threatOverlayLayer.getLayers().length > 0) {
        bounds.push(threatOverlayLayer.getBounds());
    }

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

async function loadAlertsLayer() {
    let response;
    try {
        response = await fetch(buildUrl('/map/alerts-layer'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('Fetch error:', error);
        throw new Error('Не вдалося підключитися до сервера. Перевірте з\'єднання.');
    }

    if (!response.ok) {
        throw new Error('Не вдалося оновити шар тривог.');
    }

    const data = await response.json();
    const features = data.features || [];

    // Remove old alerts layer if exists
    if (alertLayersGroup) {
        map.removeLayer(alertLayersGroup);
    }

    // Create new alerts layer
    alertLayersGroup = L.geoJSON(features, {
        style: function(feature) {
            const props = feature && feature.properties;
            const alertType = props && props.alert_type || 'air_raid';
            const palette = getAlertPalette(alertType);

            return {
                stroke: false,
                fillColor: palette.fill,
                fillOpacity: palette.fillOpacity,
            };
        },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);
}

async function loadInteractiveRegionsLayer() {
    const packVersions = activeConfig && activeConfig.overlay_config
        ? activeConfig.overlay_config.geometry_pack_versions || {}
        : {};

    // Load visible layers based on current zoom (excluding oblast - handled by loadOblastBorders)
    const visibleLayers = getVisibleLayers().filter(layerId => layerId !== 'oblast');
    const allFeatures = [];

    for (const layerId of visibleLayers) {
        try {
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
                continue;
            }

            const data = await response.json();
            const features = data.features || [];
            allFeatures.push(...features);
        } catch (error) {
            console.warn('[InteractiveLayer] Failed to load', layerId, ':', error);
        }
    }

    if (allFeatures.length === 0) {
        return;
    }

    // Remove old interactive layer if exists
    if (interactiveRegionsLayer) {
        map.removeLayer(interactiveRegionsLayer);
    }

    // Create invisible but interactive layer for clicks
    interactiveRegionsLayer = L.geoJSON(allFeatures, {
        style: {
            stroke: false,
            fillOpacity: 0,
            interactive: true,
        },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);

    console.log('[InteractiveLayer] Loaded', allFeatures.length, 'regions for click handling');
}

async function loadOblastBorders() {
    console.log('[OblastBorders] Starting to load oblast borders...');
    let response;
    try {
        response = await fetch(buildUrl('/map/simplified-oblast'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('[OblastBorders] Fetch error:', error);
        throw new Error('Не вдалося підключитися до сервера. Перевірте з\'єднання.');
    }

    if (!response.ok) {
        // Borders layer is optional, proceed without it
        console.warn('[OblastBorders] Failed to load:', response.status, response.statusText);
        return;
    }

    const data = await response.json();
    const oblasts = data.oblasts || [];

    if (!oblasts.length) {
        console.warn('[OblastBorders] No oblasts data received');
        return;
    }

    const features = oblasts.map(function(oblast) {
        return {
            type: 'Feature',
            properties: {
                uid: oblast.uid,
                title_uk: oblast.title_uk,
                status: oblast.status,
                alert_type: oblast.alert_type,
            },
            geometry: oblast.geometry || null,
        };
    }).filter(function(f) { return f.geometry !== null; });

    console.log('[OblastBorders] Loaded', features.length, 'oblast borders');

    // Remove old borders layer if exists
    if (oblastBordersLayer) {
        console.log('[OblastBorders] Removing old borders layer');
        map.removeLayer(oblastBordersLayer);
    }

    var isDark = document.body.classList.contains('dark');
    console.log('[OblastBorders] Dark mode:', isDark);

    // Create new borders layer (stroke only, no fill, but interactive for clicks)
    oblastBordersLayer = L.geoJSON(features, {
        style: function(feature) {
            return {
                stroke: true,
                color: isDark ? '#5a7d8e' : '#5a7d8e',
                weight: 2.5,
                fillColor: isDark ? '#5a7d8e' : '#5a7d8e',
                fillOpacity: 0,
                interactive: true,
            };
        },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);

    console.log('[OblastBorders] Layer added to map, total layers:', map._layers);
}

async function refreshOverlays() {
    if (!activeConfig) {
        return;
    }

    setStatus('Оновлюємо мапу…');

    // Load layers in parallel for better performance
    // Critical layers: alerts layer + oblast borders
    await Promise.all([
        loadAlertsLayer(),
        loadOblastBorders(),
    ]);

    // Load interactive and threat layers in parallel
    await Promise.all([
        loadInteractiveRegionsLayer(),
        loadThreatOverlays(),
    ]);

    fitToVisibleData();
    refreshLayout();
    bringAlertLayersToFront();
    setStatus(null);
}
window.refreshOverlays = refreshOverlays;

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
window.scheduleOverlayRefresh = scheduleOverlayRefresh;