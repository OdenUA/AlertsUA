/**
 * Static geometry loader — loads pre-bundled GeoJSON from local APK assets.
 * Geometry never changes, so it's shipped with the APK instead of fetched from server.
 * Uses XMLHttpRequest because fetch() does NOT support file:// URLs in Android WebView.
 */

var staticGeometry = {
    loaded: false,
    oblast: null,
    raion: null,
    hromada: null,
    ukraineBoundary: null,
    occupiedTerritories: null,
    featureByUid: {},
};

function loadStaticGeometryFromAssets() {
    return new Promise(function (resolve) {
        // XMLHttpRequest works with file:// URLs in WebView when allowFileAccess is enabled
        var files = [
            { key: 'oblast', path: 'data/oblast.geojson' },
            { key: 'raion', path: 'data/raion.geojson' },
            { key: 'hromada', path: 'data/hromada.geojson' },
            { key: 'ukraineBoundary', path: 'data/ukraine-boundary.geojson' },
            { key: 'occupiedTerritories', path: 'data/occupied-territories.geojson' },
        ];

        debugLog('[StaticGeometry] Loading', files.length, 'files via XHR from assets...');

        var pending = files.length;
        var errors = [];
        var loadedInfo = [];

        files.forEach(function (file) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', file.path, true);
            xhr.onload = function () {
                try {
                    var data = JSON.parse(xhr.responseText);
                    if (file.key === 'ukraineBoundary') {
                        staticGeometry[file.key] = data.feature ? data.feature.geometry : null;
                    } else if (file.key === 'occupiedTerritories') {
                        staticGeometry[file.key] = data.feature || data.geojson || data;
                    } else {
                        staticGeometry[file.key] = data;
                    }
                    var count = (data && data.features) ? data.features.length : 0;
                    loadedInfo.push(file.key + '(' + count + ')');
                    debugLog('[StaticGeometry] Loaded', file.key, ':', count, 'features');
                } catch (e) {
                    errors.push(file.key + ': ' + e.message);
                    console.error('[StaticGeometry] Parse error for', file.key, ':', e.message);
                }
                if (--pending === 0) {
                    buildFeatureLookup();
                    staticGeometry.loaded = true;
                    debugLog('[StaticGeometry] Complete. OK:', loadedInfo.join(', '), 'Errors:', errors.length ? errors.join(', ') : 'none');
                    if (errors.length > 0) console.warn('[StaticGeometry] Errors:', errors);
                    resolve(staticGeometry);
                }
            };
            xhr.onerror = function () {
                errors.push(file.key + ': XHR error status=' + xhr.status);
                console.error('[StaticGeometry] XHR error for', file.key, 'status:', xhr.status);
                if (--pending === 0) {
                    staticGeometry.loaded = true;
                    console.error('[StaticGeometry] Load complete with errors:', errors);
                    resolve(staticGeometry);
                }
            };
            xhr.send();
        });
    });
}

function buildFeatureLookup() {
    staticGeometry.featureByUid = {};

    ['oblast', 'raion', 'hromada'].forEach(function (layerKey) {
        var layerData = staticGeometry[layerKey];
        if (!layerData || !layerData.features) return;

        layerData.features.forEach(function (feature) {
            var uid = feature.properties && feature.properties.uid;
            if (uid !== undefined && uid !== null) {
                staticGeometry.featureByUid[uid] = feature;
            }
        });
    });

    debugLog('[StaticGeometry] Feature lookup:', Object.keys(staticGeometry.featureByUid).length, 'features');
}

/**
 * Apply status bundle to static geometry objects (modifies in-place).
 * Called during initial render before layers are created.
 */
function applyBundleStatuses(bundle) {
    if (!bundle || !staticGeometry.loaded) {
        console.warn('[StaticGeometry] Cannot apply statuses: loaded=' + staticGeometry.loaded);
        return;
    }

    var statusLookup = bundle.status_lookup || {};

    ['oblast', 'raion', 'hromada'].forEach(function (layerKey) {
        var layerData = staticGeometry[layerKey];
        if (!layerData || !layerData.features) {
            console.warn('[StaticGeometry] No data for layer:', layerKey);
            return;
        }

        layerData.features.forEach(function (feature) {
            var uid = feature.properties && feature.properties.uid;
            if (uid === undefined || uid === null) return;

            var uidStr = String(uid);
            var statusInfo = statusLookup[uidStr];
            if (statusInfo) {
                feature.properties.status = statusInfo.status;
                feature.properties.alert_type = statusInfo.alert_type;
            } else {
                feature.properties.status = ' ';
                feature.properties.alert_type = 'air_raid';
            }
        });
    });

    debugLog('[StaticGeometry] Applied statuses v' + bundle.state_version +
        ', lookup size:', Object.keys(statusLookup).length);

    // Отмечаем версию как применённую, чтобы 30-секундный опрос не перерисовывал слои
    lastAppliedStateVersion = bundle.state_version || 0;
}

function applyKyivCityInheritedOblastStatus() {
    // Apply Kyiv oblast's alert status to Kyiv city feature.
    // This runs AFTER applyBundleStatuses to ensure the inherited status is set.
    if (!staticGeometry.oblast || !staticGeometry.oblast.features) return;

    var features = staticGeometry.oblast.features;
    var kyivOblast = null;
    var kyivCity = null;

    for (var i = 0; i < features.length; i++) {
        var f = features[i];
        var p = f && f.properties;
        if (!p) continue;

        var title = String(p.title_uk || '').toLowerCase().replace(/\s+/g, ' ').trim();

        if (p.region_type === 'oblast' && title === 'київська область') {
            kyivOblast = f;
        } else if (p.region_type === 'city' && (title === 'київ' || title === 'м. київ' || title === 'м київ')) {
            kyivCity = f;
        }

        if (kyivOblast && kyivCity) break;
    }

    if (!kyivOblast || !kyivCity) {
        debugLog('[StaticGeometry] Kyiv inheritance skipped:', kyivOblast ? 'oblast found' : 'no oblast', kyivCity ? 'city found' : 'no city');
        return;
    }

    var oblastStatus = kyivOblast.properties.status || ' ';
    var oblastAlertType = kyivOblast.properties.alert_type || 'air_raid';

    // Always inherit oblast status for Kyiv city
    kyivCity.properties.inherited_oblast_status = oblastStatus;
    kyivCity.properties.inherited_oblast_alert_type = oblastAlertType;

    // If city has no direct alert, use oblast status as primary
    if (kyivCity.properties.status === ' ' || kyivCity.properties.status === 'N') {
        kyivCity.properties.status = oblastStatus;
        kyivCity.properties.alert_type = oblastAlertType;
    }

    debugLog('[StaticGeometry] Kyiv city inherited oblast status:', oblastStatus,
        'city status:', kyivCity.properties.status,
        'alert_type:', kyivCity.properties.alert_type);
}

function getFeaturesByLayerId(layerId) {
    var key = layerId.replace('special', 'hromada');
    var layerData = staticGeometry[key];
    if (!layerData) {
        console.warn('[StaticGeometry] No data for layer:', layerId, '(key:', key + ')');
        return [];
    }
    return layerData.features ? layerData.features : [];
}

function getUkraineBoundaryGeometry() {
    return staticGeometry.ukraineBoundary;
}

function getOccupiedTerritoriesFeature() {
    return staticGeometry.occupiedTerritories;
}

window.staticGeometry = staticGeometry;
window.loadStaticGeometryFromAssets = loadStaticGeometryFromAssets;
window.applyBundleStatuses = applyBundleStatuses;
window.applyKyivCityInheritedOblastStatus = applyKyivCityInheritedOblastStatus;
window.getFeaturesByLayerId = getFeaturesByLayerId;
window.getUkraineBoundaryGeometry = getUkraineBoundaryGeometry;
window.getOccupiedTerritoriesFeature = getOccupiedTerritoriesFeature;
