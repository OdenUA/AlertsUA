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
    const response = await fetch(buildUrl('/map/alerts-layer'), {
        headers: {
            'Accept': 'application/json'
        }
    });

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

async function refreshOverlays() {
    if (!activeConfig) {
        return;
    }

    setStatus('Оновлюємо мапу…');

    // Load single precomputed alert layer (replaces 3 separate layer requests)
    await loadAlertsLayer();
    await loadThreatOverlays();

    fitToVisibleData();
    refreshLayout();
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
window.scheduleOverlayRefresh = scheduleOverlayRefresh;