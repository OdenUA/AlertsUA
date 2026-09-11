package com.alertsua.app.map

import org.maplibre.geojson.Geometry
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon

// Порт pointInRing/pointInGeometry из бывшего assets/leaflet/js/geometry.js (Leaflet-версия)

internal fun pointInRing(ring: List<Point>, x: Double, y: Double): Boolean {
    var inside = false
    var j = ring.size - 1
    for (i in ring.indices) {
        val xi = ring[i].longitude()
        val yi = ring[i].latitude()
        val xj = ring[j].longitude()
        val yj = ring[j].latitude()
        if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside
        }
        j = i
    }
    return inside
}

internal fun pointInGeometry(lng: Double, lat: Double, geometry: Geometry?): Boolean {
    return when (geometry) {
        is Polygon -> {
            val rings = geometry.coordinates()
            rings.isNotEmpty() && pointInRing(rings[0], lng, lat) &&
                rings.drop(1).none { pointInRing(it, lng, lat) }
        }
        is MultiPolygon -> geometry.coordinates().any { polygon ->
            polygon.isNotEmpty() && pointInRing(polygon[0], lng, lat) &&
                polygon.drop(1).none { pointInRing(it, lng, lat) }
        }
        else -> false
    }
}
