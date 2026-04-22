// UI and threat icon / arrow rendering helpers

function setStatus(message) {
    if (!statusElement) {
        statusElement = document.getElementById('status');
        if (!statusElement && !document.body) {
            return;
        }
    }

    if (!message) {
        statusElement.style.display = 'none';
        return;
    }
    statusElement.textContent = message;
    statusElement.style.display = 'block';
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatThreatPopupTime(value) {
    if (!value) {
        return '';
    }

    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return '';
    }

    return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function buildThreatPopupContent(overlay) {
    var safeMessage = escapeHtml(overlay && overlay.message_text ? overlay.message_text : '').replace(/\r?\n/g, '<br>');
    var messageTime = formatThreatPopupTime(overlay && (overlay.message_date || overlay.occurred_at));
    var footerParts = ['<span>Telegram</span>'];

    if (messageTime) {
        footerParts.push('<span class="threat-popup-dot"></span>');
        footerParts.push('<span>' + escapeHtml(messageTime) + '</span>');
    }

    return [
        '<div class="threat-popup-card">',
        '  <div class="threat-popup-header">',
        '    <div class="threat-popup-avatar">' + THREAT_LAYER_TELEGRAM_ICON_MARKUP + '</div>',
        '    <div class="threat-popup-meta">',
        '      <div class="threat-popup-author">' + escapeHtml(THREAT_POPUP_SENDER) + '</div>',
        '      <div class="threat-popup-label">Оперативне повідомлення</div>',
        '    </div>',
        '  </div>',
        '  <div class="threat-popup-bubble">',
        '    <div class="threat-popup-message">' + safeMessage + '</div>',
        '    <div class="threat-popup-footer">' + footerParts.join('') + '</div>',
        '  </div>',
        '</div>'
    ].join('');
}

function isSpecialAlertType(alertType) {
    return alertType === 'artillery_shelling' || alertType === 'urban_fights';
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

function getAlertPalette(alertType) {
    return alertTypePalette[alertType] || alertTypePalette.air_raid;
}

function getThreatIconSrc(threatKind) {
    var mode = document.body.classList.contains('dark') ? 'dark' : 'light';
    var config = THREAT_TYPE_ICONS[threatKind] || THREAT_TYPE_ICONS.unknown;
    return config[mode] || THREAT_TYPE_ICONS.unknown.light;
}

function normalizeBearingDegrees(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    var numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return null;
    }

    var normalized = numeric % 360;
    if (normalized < 0) {
        normalized += 360;
    }

    return normalized;
}

function clamp(value, minValue, maxValue) {
    return Math.min(maxValue, Math.max(minValue, value));
}

function makeThreatIcon(threatKind, bearing) {
    var src = getThreatIconSrc(threatKind);
    var angle = normalizeBearingDegrees(bearing);
    
    // KAB icon naturally points south-west (225 degrees).
    // Rotate it by +135 degrees to adjust its baseline orientation to north (0).
    if (threatKind === 'kab' && angle !== null) {
        angle = (angle + 135) % 360;
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

function createQuadraticBezierPoints(startPoint, controlPoint, endPoint, segmentCount) {
    var points = [];

    for (var index = 0; index <= segmentCount; index += 1) {
        var t = index / segmentCount;
        var oneMinusT = 1 - t;
        points.push(L.point(
            (oneMinusT * oneMinusT * startPoint.x) + (2 * oneMinusT * t * controlPoint.x) + (t * t * endPoint.x),
            (oneMinusT * oneMinusT * startPoint.y) + (2 * oneMinusT * t * controlPoint.y) + (t * t * endPoint.y)
        ));
    }

    return points;
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
    var curveStartPoint = L.point(startPoint.x + (unitX * 14), startPoint.y + (unitY * 14));
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
        THREAT_DIRECTION_ARC_MIN_OFFSET_PX,
        Math.min(THREAT_DIRECTION_ARC_MAX_OFFSET_PX, curveDistancePx * 0.14)
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

    var tailPoint = arcPoints[arcPoints.length - 2];
    var arrowDeltaX = targetPoint.x - tailPoint.x;
    var arrowDeltaY = targetPoint.y - tailPoint.y;
    var arrowDistancePx = Math.sqrt((arrowDeltaX * arrowDeltaX) + (arrowDeltaY * arrowDeltaY));
    if (arrowDistancePx < 1) {
        return;
    }

    var arrowUnitX = arrowDeltaX / arrowDistancePx;
    var arrowUnitY = arrowDeltaY / arrowDistancePx;
    var arrowBasePoint = L.point(
        targetPoint.x - (arrowUnitX * directionStyle.arrowLengthPx),
        targetPoint.y - (arrowUnitY * directionStyle.arrowLengthPx)
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
        map.unproject(targetPoint, zoom),
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
            var icon = makeThreatIcon(overlay.threat_kind || overlay.icon_type || 'unknown', resolveThreatBearing(overlay));
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

var showThreats = true;

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

async function loadThreatOverlays() {
    const response = await fetch(buildUrl('/map/threat-overlays'), {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error('Не вдалося оновити шар загроз на мапі.');
    }

    const data = await response.json();
    threatOverlayData = data.overlays || [];
    renderThreatOverlays();
}
