function normalizeBearingDegrees(value) {
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

function calculateBearingDegrees(startLat, startLng, endLat, endLng) {
    var startLatRad = startLat * (Math.PI / 180);
    var endLatRad = endLat * (Math.PI / 180);
    var deltaLngRad = (endLng - startLng) * (Math.PI / 180);

    var y = Math.sin(deltaLngRad) * Math.cos(endLatRad);
    var x =
        (Math.cos(startLatRad) * Math.sin(endLatRad)) -
        (Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLngRad));

    var bearing = Math.atan2(y, x) * (180 / Math.PI);
    return normalizeBearingDegrees(bearing);
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
    // Fallback: check against loaded oblast features
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