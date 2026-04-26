function getThreatIconSrc(threatKind) {
    var mode = document.body.classList.contains('dark') ? 'dark' : 'light';
    var config = THREAT_TYPE_ICONS[threatKind] || THREAT_TYPE_ICONS.unknown;
    return config[mode] || THREAT_TYPE_ICONS.unknown.light;
}

function getAlertPalette(alertType) {
    return alertTypePalette[alertType] || alertTypePalette.air_raid;
}

function makeAlertIcon(alertType, sizePx) {
    const src = ALERT_TYPE_ICONS[alertType] || ALERT_ICON_FALLBACK;
    const sz = Math.max(12, Math.round(sizePx || 24));
    return L.divIcon({
        className: '',
        html: '<div class="al-marker"><img src="' + src + '" style="width:' + sz + 'px;height:' + sz + 'px;" /></div>',
        iconSize: [sz, sz],
        iconAnchor: [sz / 2, sz / 2],
    });
}

function getThreatDirectionStyle(zoom) {
    var zoomScale = 1 + ((zoom - THREAT_DIRECTION_ZOOM_BASE) * THREAT_DIRECTION_ZOOM_SCALE_STEP);

    return {
        lineWeight: clamp(
            THREAT_DIRECTION_BASE_LINE_WEIGHT * zoomScale,
            THREAT_DIRECTION_MIN_LINE_WEIGHT,
            THREAT_DIRECTION_MAX_LINE_WEIGHT
        ),
        arrowLengthPx: clamp(
            THREAT_DIRECTION_BASE_ARROW_LENGTH_PX * zoomScale,
            THREAT_DIRECTION_MIN_ARROW_LENGTH_PX,
            THREAT_DIRECTION_MAX_ARROW_LENGTH_PX
        ),
        arrowWidthPx: clamp(
            THREAT_DIRECTION_BASE_ARROW_WIDTH_PX * zoomScale,
            THREAT_DIRECTION_MIN_ARROW_WIDTH_PX,
            THREAT_DIRECTION_MAX_ARROW_WIDTH_PX
        ),
    };
}

function getCorridorEndpoints(overlay) {
    var corridor = overlay && overlay.corridor;
    if (!corridor || corridor.type !== 'LineString' || !Array.isArray(corridor.coordinates) || corridor.coordinates.length < 2) {
        return null;
    }

    var start = corridor.coordinates[0];
    var end = corridor.coordinates[corridor.coordinates.length - 1];
    if (!Array.isArray(start) || !Array.isArray(end) || start.length < 2 || end.length < 2) {
        return null;
    }

    var startLng = Number(start[0]);
    var startLat = Number(start[1]);
    var endLng = Number(end[0]);
    var endLat = Number(end[1]);
    if (!Number.isFinite(startLat) || !Number.isFinite(startLng) || !Number.isFinite(endLat) || !Number.isFinite(endLng)) {
        return null;
    }

    return {
        startLat: startLat,
        startLng: startLng,
        endLat: endLat,
        endLng: endLng,
    };
}

function getCorridorBearing(overlay) {
    var endpoints = getCorridorEndpoints(overlay);
    if (!endpoints) {
        return null;
    }

    if (endpoints.startLat === endpoints.endLat && endpoints.startLng === endpoints.endLng) {
        return null;
    }

    return calculateBearingDegrees(endpoints.startLat, endpoints.startLng, endpoints.endLat, endpoints.endLng);
}

function getThreatDestinationLatLng(overlay) {
    var endpoints = getCorridorEndpoints(overlay);
    if (!endpoints) {
        return null;
    }

    return L.latLng(endpoints.endLat, endpoints.endLng);
}

function resolveThreatBearing(overlay) {
    var explicitBearing = normalizeBearingDegrees(overlay && overlay.movement_bearing_deg);
    var corridorBearing = getCorridorBearing(overlay);

    if (corridorBearing === null) {
        return explicitBearing;
    }

    if (explicitBearing === null) {
        return corridorBearing;
    }

    var difference = Math.abs(explicitBearing - corridorBearing);
    var shortestDifference = Math.min(difference, 360 - difference);
    if (explicitBearing === 0 && shortestDifference > 1) {
        return corridorBearing;
    }

    return explicitBearing;
}

function makeThreatIcon(threatKind, bearing, overlay) {
    var src = getThreatIconSrc(threatKind);
    var angle = normalizeBearingDegrees(bearing);

    // KAB icon naturally points south-west (225 degrees).
    // Rotate it by +135 degrees to adjust its baseline orientation to north (0)
    // ONLY when there's a corridor with distinct origin and target points.
    if (threatKind === 'kab' && angle !== null) {
        // Check if overlay has a corridor with distinct origin/target
        var corridor = overlay && overlay.corridor;
        var hasDistinctCorridor = false;
        if (corridor && corridor.type === 'LineString' && Array.isArray(corridor.coordinates) && corridor.coordinates.length >= 2) {
            var start = corridor.coordinates[0];
            var end = corridor.coordinates[corridor.coordinates.length - 1];
            if (Array.isArray(start) && Array.isArray(end) && start.length >= 2 && end.length >= 2) {
                var startLng = Number(start[0]);
                var startLat = Number(start[1]);
                var endLng = Number(end[0]);
                var endLat = Number(end[1]);
                if (Number.isFinite(startLat) && Number.isFinite(startLng) && Number.isFinite(endLat) && Number.isFinite(endLng)) {
                    // Check if origin and target are different
                    hasDistinctCorridor = (startLat !== endLat || startLng !== endLng);
                }
            }
        }

        // Only apply rotation adjustment if there's a distinct corridor
        if (hasDistinctCorridor) {
            angle = (angle + 135) % 360;
        }
    }

    var bearingStyle = '';
    if (angle !== null && Number.isFinite(angle)) {
        bearingStyle = '--threat-bearing-deg:' + angle + 'deg;';
    }

    // Adjust threat icon size for extreme zoom levels:
    var baseSize = 28;
    var zoom = (typeof map.getZoom === 'function') ? map.getZoom() : THREAT_DIRECTION_ZOOM_BASE;
    var minZoom = (typeof map.getMinZoom === 'function') ? map.getMinZoom() : NaN;

    var sizePx = baseSize;
    if (Number.isFinite(minZoom)) {
        if (zoom <= minZoom) {
            // Max zoomed out: make icons smaller.
            sizePx = Math.round(baseSize * 0.6); // ~17px
        } else if (zoom <= (minZoom + 1)) {
            // One level closer: moderately smaller.
            sizePx = Math.round(baseSize * 0.78); // ~22px
        }
    } else {
        // Fallback: for very low zooms reduce slightly.
        if (zoom <= (THREAT_DIRECTION_ZOOM_BASE - 2)) {
            sizePx = Math.round(baseSize * 0.78);
        }
    }

    var iconSize = [sizePx, sizePx];
    var iconAnchor = [Math.round(sizePx / 2), Math.round(sizePx / 2)];
    var markerClass = 'al-marker threat-marker' + (sizePx < baseSize ? ' al-small' : '');

    return L.divIcon({
        className: '',
        html: '<div class="' + markerClass + '"><img src="' + src + '" style="' + bearingStyle + 'width:' + sizePx + 'px;height:' + sizePx + 'px;" /></div>',
        iconSize: iconSize,
        iconAnchor: iconAnchor,
    });
}

function makeThreatTapTargetIcon() {
    return L.divIcon({
        className: '',
        html: '<div class="threat-hit-area"></div>',
        iconSize: [THREAT_MARKER_TAP_TARGET_PX, THREAT_MARKER_TAP_TARGET_PX],
        iconAnchor: [THREAT_MARKER_TAP_TARGET_PX / 2, THREAT_MARKER_TAP_TARGET_PX / 2],
    });
}

function extractOverlayMarkerLatLng(overlay) {
    var marker = overlay && overlay.marker;
    if (!marker || marker.type !== 'Point' || !Array.isArray(marker.coordinates) || marker.coordinates.length < 2) {
        return null;
    }

    var lng = Number(marker.coordinates[0]);
    var lat = Number(marker.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }

    return [lat, lng];
}

function addThreatDirectionIndicator(layerGroup, entry, markerLatLng) {
    var overlay = entry && entry.overlay;
    var destinationLatLng = getThreatDestinationLatLng(overlay);
    if (!destinationLatLng) {
        return;
    }

    var displayedMarkerLatLng = markerLatLng || map.unproject(entry.point, map.getZoom());
    var distanceMeters = displayedMarkerLatLng.distanceTo(destinationLatLng);
    if (!(distanceMeters > THREAT_DIRECTION_MIN_DISTANCE_METERS)) {
        return;
    }

    var zoom = map.getZoom();
    var zoomScale = 1 + ((zoom - THREAT_DIRECTION_ZOOM_BASE) * THREAT_DIRECTION_ZOOM_SCALE_STEP);
    var directionStyle = getThreatDirectionStyle(zoom);
    var targetPoint = map.project(destinationLatLng, zoom);
    var startPoint = L.point(entry.point.x, entry.point.y);
    var deltaX = targetPoint.x - startPoint.x;
    var deltaY = targetPoint.y - startPoint.y;
    var distancePx = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
    if (distancePx < 1) {
        return;
    }

    var unitX = deltaX / distancePx;
    var unitY = deltaY / distancePx;
    var curveStartOffsetPx = Math.max(14 * zoomScale, 14); // Scale starting offset with zoom
    var curveStartPoint = L.point(startPoint.x + (unitX * curveStartOffsetPx), startPoint.y + (unitY * curveStartOffsetPx));
    var curveDeltaX = targetPoint.x - curveStartPoint.x;
    var curveDeltaY = targetPoint.y - curveStartPoint.y;
    var curveDistancePx = Math.sqrt((curveDeltaX * curveDeltaX) + (curveDeltaY * curveDeltaY));
    if (curveDistancePx < 1) {
        return;
    }

    var perpendicularX = -curveDeltaY / curveDistancePx;
    var perpendicularY = curveDeltaX / curveDistancePx;
    var midpoint = L.point(
        (curveStartPoint.x + targetPoint.x) / 2,
        (curveStartPoint.y + targetPoint.y) / 2
    );
    var arcOffsetPx = Math.max(
        THREAT_DIRECTION_ARC_MIN_OFFSET_PX * zoomScale, // Scale minimum offset with zoom
        Math.min(THREAT_DIRECTION_ARC_MAX_OFFSET_PX * zoomScale, curveDistancePx * 0.14) // Scale maximum offset with zoom
    );
    var controlPoint = L.point(
        midpoint.x + (perpendicularX * arcOffsetPx),
        midpoint.y + (perpendicularY * arcOffsetPx)
    );
    var arcPoints = createQuadraticBezierPoints(curveStartPoint, controlPoint, targetPoint, THREAT_DIRECTION_ARC_SEGMENTS);
    if (arcPoints.length < 2) {
        return;
    }
    var strokeColor = THREAT_DIRECTION_COLOR;
    L.polyline(arcPoints.map(function (point) {
        return map.unproject(point, zoom);
    }), {
        color: strokeColor,
        weight: directionStyle.lineWeight,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
    }).addTo(layerGroup);

    // Draw arrow head at target point, pointing back along the curve direction
    var arrowTipPoint = arcPoints[arcPoints.length - 1];
    var arrowDirectionPoint = arcPoints[Math.max(0, arcPoints.length - 3)]; // Use point near end for direction
    var arrowDeltaX = arrowTipPoint.x - arrowDirectionPoint.x;
    var arrowDeltaY = arrowTipPoint.y - arrowDirectionPoint.y;
    var arrowDistancePx = Math.sqrt((arrowDeltaX * arrowDeltaX) + (arrowDeltaY * arrowDeltaY));
    if (arrowDistancePx < 1) {
        return;
    }

    var arrowUnitX = arrowDeltaX / arrowDistancePx;
    var arrowUnitY = arrowDeltaY / arrowDistancePx;
    var arrowBasePoint = L.point(
        arrowTipPoint.x - (arrowUnitX * directionStyle.arrowLengthPx),
        arrowTipPoint.y - (arrowUnitY * directionStyle.arrowLengthPx)
    );
    var arrowPerpendicularX = -arrowUnitY;
    var arrowPerpendicularY = arrowUnitX;
    var arrowLeftPoint = L.point(
        arrowBasePoint.x + (arrowPerpendicularX * directionStyle.arrowWidthPx),
        arrowBasePoint.y + (arrowPerpendicularY * directionStyle.arrowWidthPx)
    );
    var arrowRightPoint = L.point(
        arrowBasePoint.x - (arrowPerpendicularX * directionStyle.arrowWidthPx),
        arrowBasePoint.y - (arrowPerpendicularY * directionStyle.arrowWidthPx)
    );

    L.polygon([
        map.unproject(arrowTipPoint, zoom),
        map.unproject(arrowLeftPoint, zoom),
        map.unproject(arrowRightPoint, zoom),
    ], {
        stroke: false,
        fillColor: strokeColor,
        fillOpacity: 0.9,
        interactive: false,
    }).addTo(layerGroup);
}

function getThreatMarkerSeparationPx() {
    var zoom = map.getZoom();
    if (zoom <= 5) {
        return 20;
    }
    if (zoom <= 6) {
        return 20;
    }
    if (zoom <= 7) {
        return 20;
    }
    if (zoom <= 8) {
        return 20;
    }
    if (zoom <= 10) {
        return 16;
    }
    return 12;
}

function resolveThreatMarkerEntries(overlays) {
    var zoom = map.getZoom();
    var minSeparationPx = getThreatMarkerSeparationPx();
    var entries = [];

    overlays.forEach(function (overlay, index) {
        var markerLatLng = extractOverlayMarkerLatLng(overlay);
        if (!markerLatLng) {
            return;
        }

        var basePoint = map.project(L.latLng(markerLatLng[0], markerLatLng[1]), zoom);
        entries.push({
            overlay: overlay,
            index: index,
            basePoint: L.point(basePoint.x, basePoint.y),
            point: L.point(basePoint.x, basePoint.y),
        });
    });

    if (entries.length <= 1) {
        return entries;
    }

    var maxIterations = 12;
    var maxOffsetPx = minSeparationPx * 2.8;

    for (var iteration = 0; iteration < maxIterations; iteration += 1) {
        var moved = false;

        for (var leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
            for (var rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
                var leftEntry = entries[leftIndex];
                var rightEntry = entries[rightIndex];
                var deltaX = rightEntry.point.x - leftEntry.point.x;
                var deltaY = rightEntry.point.y - leftEntry.point.y;
                var distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));

                if (distance >= minSeparationPx) {
                    continue;
                }

                moved = true;

                if (distance < 0.01) {
                    var seedAngle = (leftEntry.index + rightEntry.index + iteration + 1) * 2.3999632297;
                    deltaX = Math.cos(seedAngle);
                    deltaY = Math.sin(seedAngle);
                    distance = 1;
                }

                var overlap = (minSeparationPx - distance) / 2;
                var unitX = deltaX / distance;
                var unitY = deltaY / distance;

                leftEntry.point.x -= unitX * overlap;
                leftEntry.point.y -= unitY * overlap;
                rightEntry.point.x += unitX * overlap;
                rightEntry.point.y += unitY * overlap;
            }
        }

        entries.forEach(function (entry) {
            var tetherX = entry.point.x - entry.basePoint.x;
            var tetherY = entry.point.y - entry.basePoint.y;
            var tetherDistance = Math.sqrt((tetherX * tetherX) + (tetherY * tetherY));

            if (tetherDistance > maxOffsetPx) {
                var clampScale = maxOffsetPx / tetherDistance;
                entry.point.x = entry.basePoint.x + (tetherX * clampScale);
                entry.point.y = entry.basePoint.y + (tetherY * clampScale);
            }
        });

        if (!moved) {
            break;
        }
    }

    return entries;
}

function buildThreatOverlayLayer(overlays) {
    var layerGroup = L.layerGroup();

    overlays.forEach(function (overlay) {
        if (!overlay.area) {
            return;
        }

        L.geoJSON({
            type: 'Feature',
            geometry: overlay.area,
            properties: {}
        }, {
            style: {
                color: overlay.color_hex || '#d7263d',
                weight: 1.4,
                opacity: 0.7,
                fillColor: overlay.color_hex || '#d7263d',
                fillOpacity: 0.16,
            },
            interactive: false,
        }).addTo(layerGroup);
    });

    resolveThreatMarkerEntries(overlays).forEach(function (entry) {
        try {
            var overlay = entry.overlay;
            var markerLatLng = map.unproject(entry.point, map.getZoom());
            var hasPopup = Boolean(overlay.message_text && overlay.message_date);
            addThreatDirectionIndicator(layerGroup, entry, markerLatLng);
            var icon = makeThreatIcon(overlay.threat_kind || overlay.icon_type || 'unknown', resolveThreatBearing(overlay), overlay);
            var mk = L.marker([markerLatLng.lat, markerLatLng.lng], {
                icon: icon,
                interactive: false,
                zIndexOffset: 760,
            });

            if (hasPopup) {
                var popupContent = buildThreatPopupContent(overlay);
                var hitMarker = L.marker([markerLatLng.lat, markerLatLng.lng], {
                    icon: makeThreatTapTargetIcon(),
                    interactive: true,
                    zIndexOffset: 750,
                });
                hitMarker.bindPopup(popupContent, { maxWidth: 300, minWidth: 200, className: 'threat-custom-popup' });
                hitMarker.addTo(layerGroup);
            }

            mk.addTo(layerGroup);
        } catch (err) {
            console.error('Error drawing overlay marker:', err, entry.overlay);
        }
    });

    return layerGroup;
}

function renderThreatOverlays() {
    if (threatOverlayLayer) {
        map.removeLayer(threatOverlayLayer);
    }

    threatOverlayLayer = buildThreatOverlayLayer(threatOverlayData);
    if (showThreats) {
        threatOverlayLayer.addTo(map);
    }
}

let showThreats = true;

function setThreatsVisibility(visible) {
    showThreats = visible;
    if (threatOverlayLayer) {
        if (showThreats) {
            map.addLayer(threatOverlayLayer);
            // Also trigger a refresh right away to fetch if it was empty
            scheduleOverlayRefresh();
        } else {
            map.removeLayer(threatOverlayLayer);
        }
    }
}
window.setThreatsVisibility = setThreatsVisibility;

async function loadThreatOverlays() {
    let response;
    try {
        response = await fetch(buildUrl('/map/threat-overlays'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('Fetch error:', error);
        throw new Error('Не вдалося підключитися до сервера. Перевірте з\'єднання.');
    }

    if (!response.ok) {
        throw new Error('Не вдалося оновити шар загроз на мапі.');
    }

    const data = await response.json();
    threatOverlayData = data.overlays || [];
    renderThreatOverlays();
}