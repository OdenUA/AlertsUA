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

// Версия бандла, уже применённая к слоям карты. Если сервер вернул ту же
// версию — перерисовка не нужна (таковы ~99% 30-секундных циклов опроса).
var lastAppliedStateVersion = -1;

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

                debugLog('[StatusBundle] Received v' + bundle.state_version +
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
 * Apply cached statuses to the map layers.
 * Used for 30-second auto-refresh when layers are already rendered.
 *
 * Skips all work when the bundle state_version has not changed. When it has,
 * statuses are written into the shared static-geometry feature objects, the
 * oblast layer (always fully rendered) is restyled in place, and the
 * raion/hromada fill layers — which contain only active ('A') regions —
 * are rebuilt so their composition matches the new active set.
 */
function refreshStatusesFromCache() {
    var statusLookup = statusBundleCache.statusLookup;
    if (!statusLookup || Object.keys(statusLookup).length === 0) {
        console.warn('[StatusBundle] No statuses to apply');
        return;
    }
    if (statusBundleCache.stateVersion === lastAppliedStateVersion) {
        return;
    }
    lastAppliedStateVersion = statusBundleCache.stateVersion;

    var appliedCount = 0;

    // Mutate the shared static-geometry features (layers hold the same references)
    ['oblast', 'raion', 'hromada'].forEach(function (layerKey) {
        var layerData = staticGeometry[layerKey];
        if (!layerData || !layerData.features) return;

        layerData.features.forEach(function (feature) {
            var props = feature && feature.properties;
            if (!props) return;
            var uid = props.uid;
            if (uid === undefined || uid === null) return;

            var statusInfo = statusLookup[String(uid)];
            var newStatus = statusInfo ? statusInfo.status : ' ';
            var newAlertType = statusInfo ? statusInfo.alert_type : 'air_raid';

            if (props.status !== newStatus || props.alert_type !== newAlertType) {
                props.status = newStatus;
                props.alert_type = newAlertType;
                appliedCount++;
            }
        });
    });

    if (appliedCount === 0) {
        return;
    }

    // Apply Kyiv city inherited oblast status BEFORE updating layer styles
    if (typeof window.applyKyivCityInheritedOblastStatus === 'function') {
        window.applyKyivCityInheritedOblastStatus();
    }

    // Oblast layer always contains all features — restyle in place
    // (this also covers Kyiv city, which inherits the oblast status)
    var oblastLayer = overlayLayers['oblast'];
    if (oblastLayer) {
        oblastLayer.eachLayer(function (layerItem) {
            if (layerItem.feature) {
                layerItem.setStyle(featureStyle(layerItem.feature, 'oblast'));
            }
        });
    }

    // Raion/hromada fill layers contain only active regions — rebuild composition
    renderActiveFillLayers();

    // DO NOT reload threat overlays here — it destroys hitMarkers and their bound popups,
    // breaking the ability to reopen a popup on the same threat after closing it.
    // Threat overlays are loaded during renderAllLayers() and refresh on zoom changes
    // via renderThreatOverlays() in threat-engine.js.

    // Bring layers to correct z-order
    // Order: borders(back) → alerts → special → occupied → oblast features → threats(front)
    if (oblastBordersLayer) oblastBordersLayer.bringToBack();
    if (alertLayersGroup) _bringToFront(alertLayersGroup);
    if (specialAlertLayer) _bringToFront(specialAlertLayer);
    if (occupiedTerritoriesLayer) _bringToFront(occupiedTerritoriesLayer);
    if (overlayLayers['oblast']) overlayLayers['oblast'].bringToFront();
    if (threatOverlayLayer) _bringToFront(threatOverlayLayer);

    debugLog('[StatusBundle] Applied statuses to', appliedCount, 'features');
}

window.loadStatusBundle = loadStatusBundle;
window.refreshStatusesFromCache = refreshStatusesFromCache;
window.statusBundleCache = statusBundleCache;
