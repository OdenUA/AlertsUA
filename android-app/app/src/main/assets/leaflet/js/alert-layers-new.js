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
    // Occupied territories should be above borders but below alerts
    if (occupiedTerritoriesLayer) {
        occupiedTerritoriesLayer.bringToFront();
    }
    // Oblast features layer (with Kyiv) should be above occupied territories
    if (overlayLayers['oblast']) {
        overlayLayers['oblast'].bringToFront();
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
                interactive: true,
            };
        }

        return {
            stroke: false,
            fillColor: '#000000',
            fillOpacity: 0.001,
            interactive: true,  // Ensure Kyiv city is always clickable
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
        interactive: true,  // Ensure all features are clickable
    };
}

function selectPoint(latlng) {
    console.log('[selectPoint] Called! isThreatPopupOpen=' + window.isThreatPopupOpen);

    // Check if a popup was just closed (suppressNextClick flag from mousedown)
    if (window.suppressNextClick) {
        console.log('[selectPoint] suppressNextClick is TRUE, NOT opening bottom sheet');
        window.suppressNextClick = false;
        return;
    }

    // Also check popup state directly as a fallback
    var popup = map && map._popup;
    var isPopupOpen = popup && popup._map === map;

    if (isPopupOpen) {
        console.log('[selectPoint] Popup is still open, closing it only');
        if (map && map.closePopup) {
            map.closePopup();
        }
        return;
    }

    if (window.AndroidBridge && window.AndroidBridge.onPointSelected) {
        console.log('[selectPoint] Calling AndroidBridge.onPointSelected');
        window.AndroidBridge.onPointSelected(latlng.lat, latlng.lng);
    }
}

// Exact bounds for Kyiv city (for fallback click handling)
// From API /map/features?layer=oblast for "м. Київ"
var KYIV_CITY_BOUNDS = {
    west: 30.23,
    south: 50.21,
    east: 30.83,
    north: 50.59
};

function isInsideKyivCityBounds(latlng) {
    if (!latlng) return false;
    return latlng.lat >= KYIV_CITY_BOUNDS.south &&
           latlng.lat <= KYIV_CITY_BOUNDS.north &&
           latlng.lng >= KYIV_CITY_BOUNDS.west &&
           latlng.lng <= KYIV_CITY_BOUNDS.east;
}

function bindFeatureTooltip(feature, layer) {
    layer.on('click', function (event) {
        if (event && event.latlng) {
            // Don't open bottom sheet if a threat popup is open
            if (window.isThreatPopupOpen) {
                console.log('[FeatureClick] Threat popup is open, closing popup only');
                window.isThreatPopupOpen = false;
                if (map && map.closePopup) {
                    map.closePopup();
                }
                L.DomEvent.stopPropagation(event);
                return;
            }

            L.DomEvent.stopPropagation(event);
            // If click is within Kyiv city bounds, pass city center coordinates
            // This ensures the API resolves to "м. Київ" instead of a rural hromada
            var latlng = event.latlng;
            if (isInsideKyivCityBounds(latlng)) {
                latlng = L.latLng(50.45, 30.523);  // Kyiv city center
            }
            selectPoint(latlng);
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

/**
 * Render a layer from static geometry (loaded from assets).
 * Uses local GeoJSON instead of fetching from server.
 */
function renderLayerFromStatic(layerId) {
    console.log('[renderLayer] Rendering layer:', layerId);
    var features = getFeaturesByLayerId(layerId);
    console.log('[renderLayer] Static features for ' + layerId + ':', features.length);

    if (layerId === 'oblast') {
        applyKyivCityInheritedOblastState(features);
        var kyivFeature = features.find(isKyivCityFeature);
        console.log('[renderLayer] Kyiv city feature found:', !!kyivFeature);
    }

    var geoJsonLayer = L.geoJSON(features, {
        style: function(feature) { return featureStyle(feature, layerId); },
        onEachFeature: bindFeatureTooltip,
    });

    if (overlayLayers[layerId]) {
        map.removeLayer(overlayLayers[layerId]);
    }

    overlayLayers[layerId] = geoJsonLayer.addTo(map);
    console.log('[renderLayer] Layer ' + layerId + ' added to map');
}

/**
 * Render special alert layer from static hromada geometry.
 */
function renderSpecialAlertLayer() {
    var features = getFeaturesByLayerId('hromada');
    var specialFeatures = (features || []).filter(function(feature) {
        var props = feature && feature.properties;
        return props && props.status === 'A' && isSpecialAlertType(props.alert_type);
    });

    var geoJsonLayer = L.geoJSON(specialFeatures, {
        style: function(feature) { return featureStyle(feature, 'special'); },
        onEachFeature: bindFeatureTooltip,
    });

    if (specialAlertLayer) {
        map.removeLayer(specialAlertLayer);
    }

    specialAlertLayer = geoJsonLayer.addTo(map);
}

/**
 * Render alerts layer from static geometry.
 * Shows fill for regions with status='A'.
 */
function renderAlertsLayer() {
    var features = getFeaturesByLayerId('hromada');
    // Also include raion and city features for alerts
    var raionFeatures = getFeaturesByLayerId('raion');
    var oblastFeatures = getFeaturesByLayerId('oblast');

    var allFeatures = (features || []).concat(raionFeatures || []).concat(oblastFeatures || []);

    // Filter to fully active regions only (status 'A')
    var activeFeatures = allFeatures.filter(function(feature) {
        var props = feature && feature.properties;
        return props && props.status === 'A';
    });

    // Remove old alerts layer if exists
    if (alertLayersGroup) {
        map.removeLayer(alertLayersGroup);
    }

    // Create new alerts layer
    alertLayersGroup = L.geoJSON(activeFeatures, {
        style: function(feature) {
            var props = feature && feature.properties;
            var alertType = props && props.alert_type || 'air_raid';
            var palette = getAlertPalette(alertType);

            return {
                stroke: false,
                fillColor: palette.fill,
                fillOpacity: palette.fillOpacity,
            };
        },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);
}

/**
 * Render interactive regions layer from static geometry.
 * Invisible but clickable layer for non-alert areas.
 */
function renderInteractiveRegionsLayer() {
    var visibleLayers = getVisibleLayers().filter(function(layerId) { return layerId !== 'oblast'; });
    var allFeatures = [];

    visibleLayers.forEach(function(layerId) {
        var features = getFeaturesByLayerId(layerId);
        if (features && features.length > 0) {
            allFeatures = allFeatures.concat(features);
        }
    });

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

/**
 * Render oblast borders from static geometry.
 */
function renderOblastBorders() {
    console.log('[OblastBorders] Rendering oblast borders from static geometry...');
    var features = getFeaturesByLayerId('oblast');

    if (!features || features.length === 0) {
        console.warn('[OblastBorders] No oblast features in static geometry');
        return;
    }

    console.log('[OblastBorders] Loaded', features.length, 'oblast borders');

    // Remove old borders layer if exists
    if (oblastBordersLayer) {
        console.log('[OblastBorders] Removing old borders layer');
        map.removeLayer(oblastBordersLayer);
    }

    var isDark = document.body.classList.contains('dark');
    console.log('[OblastBorders] Dark mode:', isDark);

    // Create borders layer (stroke only, no fill, but interactive for clicks)
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

    console.log('[OblastBorders] Layer added to map, total layers:', Object.keys(map._layers).length);
}

/**
 * Render occupied territories — try static geometry first, fallback to server.
 */
async function renderOccupiedTerritories() {
    console.log('[OccupiedTerritories] Loading...');

    // Remove old layer if exists
    if (occupiedTerritoriesLayer) {
        map.removeLayer(occupiedTerritoriesLayer);
    }

    var feature = getOccupiedTerritoriesFeature();

    // If static geometry is empty, try fetching from server
    if (!feature || (feature.features && feature.features.length === 0)) {
        try {
            console.log('[OccupiedTerritories] Static data empty, fetching from server...');
            var resp = await fetch(buildUrl('/map/occupied-territories'), {
                headers: { 'Accept': 'application/json' }
            });
            if (resp.ok) {
                var data = await resp.json();
                if (data.geojson && data.geojson.features && data.geojson.features.length > 0) {
                    feature = { type: 'FeatureCollection', features: data.geojson.features };
                    console.log('[OccupiedTerritories] Loaded from server:', feature.features.length, 'features');
                }
            }
        } catch (e) {
            console.warn('[OccupiedTerritories] Server fetch failed:', e);
        }
    }

    if (!feature || (feature.features && feature.features.length === 0)) {
        console.warn('[OccupiedTerritories] No data available');
        return;
    }

    var isDark = document.body.classList.contains('dark');
    occupiedTerritoriesLayer = L.geoJSON(feature, {
        style: function() {
            return {
                stroke: true,
                color: isDark ? '#884444' : '#aa4444',
                weight: 1.5,
                fillColor: isDark ? '#663333' : '#aa4444',
                fillOpacity: 0.25,
                dashArray: '4,4',
                interactive: false,
            };
        },
    }).addTo(map);

    console.log('[OccupiedTerritories] Layer added to map');
}

/**
 * Fetch status bundle from server and apply to static geometry.
 * This replaces the old refreshOverlays() that fetched full geometry every time.
 */
async function loadStatusBundle() {
    console.log('[StatusBundle] Fetching /map/bundle...');
    try {
        var response = await fetch(buildUrl('/map/bundle'), {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error('Server returned ' + response.status);
        }

        var bundle = await response.json();
        console.log('[StatusBundle] Received bundle v' + bundle.state_version +
            ', active:', bundle.active_alerts_count + '/' + bundle.status_lookup_size);

        // Apply statuses to static geometry
        applyBundleStatuses(bundle);

        // Re-render all layers with updated statuses
        renderAlertsLayer();
        renderSpecialAlertLayer();

        // Re-render visible feature layers
        var visibleLayers = getVisibleLayers();
        visibleLayers.forEach(function(layerId) {
            renderLayerFromStatic(layerId);
        });

        // Re-render oblast borders
        renderOblastBorders();

        // Re-render interactive layer
        renderInteractiveRegionsLayer();

        fitToVisibleData();
        refreshLayout();
        bringAlertLayersToFront();
        setStatus(null);

    } catch (error) {
        console.error('[StatusBundle] Failed:', error);
        setStatus(error.message || 'Не вдалося оновити статуси.');
    }
}

/**
 * Initial render of all layers from static geometry.
 * Called once at startup after static geometry is loaded.
 */
async function renderAllLayers() {
    if (!activeConfig) {
        return;
    }

    console.log('[renderAllLayers] Rendering all layers from static geometry...');
    setStatus('Завантажуємо мапу…');

    // Add zoom controls (moved from old initializeMap)
    if (typeof removeCustomZoomControls === 'function') removeCustomZoomControls();
    if (typeof addCustomZoomControls === 'function') addCustomZoomControls();

    // Render static layers that don't depend on alert status
    await renderOblastBorders();
    await renderOccupiedTerritories();
    renderInteractiveRegionsLayer();

    // Render threat overlays
    if (typeof loadThreatOverlays === 'function') {
        try {
            await loadThreatOverlays();
        } catch (e) {
            console.warn('[renderAllLayers] Threat overlays failed:', e);
        }
    }

    // Now fetch status bundle and apply to static geometry
    // This MUST happen before rendering alert-dependent layers
    await loadStatusBundle();

    console.log('[renderAllLayers] All layers rendered');
}

/**
 * Auto-refresh: only fetch status bundle, geometry is static.
 */
function scheduleOverlayRefresh() {
    if (refreshTimerId) {
        window.clearTimeout(refreshTimerId);
    }

    refreshTimerId = window.setTimeout(function() {
        loadStatusBundle().catch(function(error) {
            console.error(error);
            setStatus(error.message || 'Не вдалося оновити мапу.');
        });
    }, 160);
}
window.scheduleOverlayRefresh = scheduleOverlayRefresh;
