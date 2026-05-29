/**
 * Status bundle loader — fetches only status data from server.
 * Lightweight (~86KB) — no geometry, just status lookup by uid.
 */

var statusBundleCache = {
    stateVersion: 0,
    statusLookup: {},
    activeAlertUids: [],
    updatedAt: 0,
};

function loadStatusBundle() {
    return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', buildUrl('/map/bundle'), true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onload = function () {
            try {
                var bundle = JSON.parse(xhr.responseText);
                statusBundleCache.stateVersion = bundle.state_version || 0;
                statusBundleCache.statusLookup = bundle.status_lookup || {};
                statusBundleCache.activeAlertUids = bundle.active_alert_uids || [];
                statusBundleCache.updatedAt = Date.now();

                console.log('[StatusBundle] Received v' + bundle.state_version +
                    ', active:', bundle.active_alerts_count +
                    ', lookup:', Object.keys(statusBundleCache.statusLookup).length);

                resolve(bundle);
            } catch (e) {
                console.error('[StatusBundle] Parse error:', e.message);
                reject(new Error('Не вдалося оновити статуси.'));
            }
        };
        xhr.onerror = function () {
            console.error('[StatusBundle] XHR error');
            reject(new Error('Не вдалося підключитися до сервера.'));
        };
        xhr.send();
    });
}

/**
 * Rebuild the alerts fill layer from current feature statuses.
 */
function rebuildAlertsLayerFromStatuses() {
    var allFeatures = [];
    ['oblast', 'raion', 'hromada'].forEach(function (layerId) {
        var layer = overlayLayers[layerId];
        if (!layer) return;
        layer.eachLayer(function (li) {
            if (li.feature) allFeatures.push(li.feature);
        });
    });

    var activeFeatures = allFeatures.filter(function (f) {
        return f && f.properties && f.properties.status === 'A';
    });

    if (alertLayersGroup) map.removeLayer(alertLayersGroup);

    alertLayersGroup = L.geoJSON(activeFeatures, {
        style: function (feature) {
            var props = feature && feature.properties;
            var alertType = props && props.alert_type || 'air_raid';
            var palette = getAlertPalette(alertType);
            return { stroke: false, fillColor: palette.fill, fillOpacity: palette.fillOpacity };
        },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);
}

/**
 * Rebuild special alert layer from current feature statuses.
 */
function rebuildSpecialAlertLayer() {
    var allFeatures = [];
    var hl = overlayLayers['hromada'];
    if (hl) hl.eachLayer(function (li) { if (li.feature) allFeatures.push(li.feature); });

    var specialFeatures = allFeatures.filter(function (f) {
        return f && f.properties && f.properties.status === 'A' && isSpecialAlertType(f.properties.alert_type);
    });

    if (specialAlertLayer) map.removeLayer(specialAlertLayer);
    specialAlertLayer = L.geoJSON(specialFeatures, {
        style: function (f) { return featureStyle(f, 'special'); },
        onEachFeature: bindFeatureTooltip,
    }).addTo(map);
}

/**
 * Bring a layer or layer group to front.
 * L.layerGroup doesn't have bringToFront, so we iterate children.
 */
function _bringToFront(layer) {
    if (!layer) return;
    if (typeof layer.bringToFront === 'function') {
        layer.bringToFront();
    } else if (typeof layer.eachLayer === 'function') {
        layer.eachLayer(function (l) {
            if (l && typeof l.bringToFront === 'function') l.bringToFront();
        });
    }
}

/**
 * Apply cached statuses AND refresh threat overlays.
 * CRITICAL: Threat overlays must be refreshed every cycle — lives depend on timely updates.
 * Used for 30-second auto-refresh when layers are already rendered.
 */
function refreshStatusesFromCache() {
    var statusLookup = statusBundleCache.statusLookup;
    if (!statusLookup || Object.keys(statusLookup).length === 0) {
        console.warn('[StatusBundle] No statuses to apply');
        return;
    }

    var appliedCount = 0;

    // Apply Kyiv city inherited oblast status BEFORE updating layer styles
    if (typeof window.applyKyivCityInheritedOblastStatus === 'function') {
        window.applyKyivCityInheritedOblastStatus();
    }

    ['oblast', 'raion', 'hromada'].forEach(function (layerId) {
        var layer = overlayLayers[layerId];
        if (!layer) return;

        layer.eachLayer(function (layerItem) {
            var feature = layerItem.feature;
            if (!feature || !feature.properties) return;

            var uid = feature.properties.uid;
            if (uid === undefined || uid === null) return;

            var uidStr = String(uid);
            var statusInfo = statusLookup[uidStr];
            var newStatus = statusInfo ? statusInfo.status : ' ';
            var newAlertType = statusInfo ? statusInfo.alert_type : 'air_raid';

            if (feature.properties.status !== newStatus || feature.properties.alert_type !== newAlertType) {
                feature.properties.status = newStatus;
                feature.properties.alert_type = newAlertType;
                appliedCount++;
                layerItem.setStyle(featureStyle(feature, layerId));
            }
        });
    });

    // Update Kyiv city style specifically — it inherits oblast status
    if (overlayLayers['oblast']) {
        overlayLayers['oblast'].eachLayer(function(layerItem) {
            var feature = layerItem.feature;
            if (!feature || !feature.properties) return;
            var title = String(feature.properties.title_uk || '').toLowerCase().replace(/\s+/g, ' ').trim();
            var isKyivCity = feature.properties.region_type === 'city' &&
                (title === 'київ' || title === 'м. київ' || title === 'м київ');
            if (isKyivCity) {
                layerItem.setStyle(featureStyle(feature, 'oblast'));
                console.log('[StatusBundle] Kyiv city style updated, status:', feature.properties.status);
            }
        });
    }

    rebuildAlertsLayerFromStatuses();
    rebuildSpecialAlertLayer();

    // DO NOT reload threat overlays here — it destroys hitMarkers and their bound popups,
    // breaking the ability to reopen a popup on the same threat after closing it.
    // Threat overlays are loaded during renderAllLayers() and refresh on zoom changes
    // via renderThreatOverlays() in threat-engine.js.

    // Bring layers to correct z-order
    // Order: borders(back) → alerts → special → occupied → oblast features → interactive → markers → threats(front)
    if (oblastBordersLayer) oblastBordersLayer.bringToBack();
    if (alertLayersGroup) _bringToFront(alertLayersGroup);
    if (specialAlertLayer) _bringToFront(specialAlertLayer);
    if (occupiedTerritoriesLayer) _bringToFront(occupiedTerritoriesLayer);
    if (overlayLayers['oblast']) overlayLayers['oblast'].bringToFront();
    if (interactiveRegionsLayer) interactiveRegionsLayer.bringToFront();
    if (threatOverlayLayer) _bringToFront(threatOverlayLayer);

    console.log('[StatusBundle] Applied statuses to', appliedCount, 'features');
}

window.loadStatusBundle = loadStatusBundle;
window.refreshStatusesFromCache = refreshStatusesFromCache;
window.statusBundleCache = statusBundleCache;
