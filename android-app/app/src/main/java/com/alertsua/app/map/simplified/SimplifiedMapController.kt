package com.alertsua.app.map.simplified

import com.alertsua.app.data.ActiveAlertGeometry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.*

class SimplifiedMapController {
    private val _oblasts = MutableStateFlow<List<OblastData>>(emptyList())
    val oblasts: StateFlow<List<OblastData>> = _oblasts

    private val _activeAlerts = MutableStateFlow<List<ActiveAlertGeometry>>(emptyList())
    val activeAlerts: StateFlow<List<ActiveAlertGeometry>> = _activeAlerts

    private val _selectedOblast = MutableStateFlow<OblastData?>(null)
    val selectedOblast: StateFlow<OblastData?> = _selectedOblast

    private val _tapTrigger = MutableStateFlow(0)
    val tapTrigger: StateFlow<Int> = _tapTrigger

    var centerLon = 31.0
        private set
    var centerLat = 48.5
        private set
    var zoom = 6.5
        private set

    private val _renderVersion = MutableStateFlow(0)
    val renderVersion: StateFlow<Int> = _renderVersion

    fun updateOblasts(newOblasts: List<OblastData>) {
        _oblasts.value = newOblasts
    }

    fun updateActiveAlerts(alerts: List<ActiveAlertGeometry>) {
        _activeAlerts.value = alerts
        _renderVersion.value++
    }

    // Convert screen pixel offset to geo coordinates, apply to center
    fun panByPixels(dx: Float, dy: Float, viewWidth: Float, viewHeight: Float) {
        val wp = worldPixels()
        val cx = lonToX(centerLon, wp)
        val cy = latToY(centerLat, wp)

        // Drag moves content: center shifts opposite to finger direction
        val newCx = cx - dx.toDouble()
        val newCy = cy - dy.toDouble()

        centerLon = xToLon(newCx, wp)
        centerLat = yToLat(newCy, wp)

        centerLat = centerLat.coerceIn(44.0, 52.5)
        centerLon = centerLon.coerceIn(22.0, 40.5)
        _renderVersion.value++
    }

    fun zoomBy(delta: Float, pivotX: Float, pivotY: Float, viewWidth: Float, viewHeight: Float) {
        val oldWp = worldPixels()
        val oldZoom = zoom

        zoom = (zoom + delta.toDouble()).coerceIn(6.0, 8.0)
        if (zoom == oldZoom) return

        val newWp = worldPixels()

        // Convert pivot screen pos to geo under old zoom
        val oldCx = lonToX(centerLon, oldWp)
        val oldCy = latToY(centerLat, oldWp)
        val pivotWx = oldCx + (pivotX.toDouble() - viewWidth.toDouble() / 2.0)
        val pivotWy = oldCy + (pivotY.toDouble() - viewHeight.toDouble() / 2.0)
        val pivotLon = xToLon(pivotWx, oldWp)
        val pivotLat = yToLat(pivotWy, oldWp)

        // Under new zoom, same geo point has new world-pixel coords
        val newPivotWx = lonToX(pivotLon, newWp)
        val newPivotWy = latToY(pivotLat, newWp)

        // Keep pivot at same screen position → compute new center
        val newCx = newPivotWx - (pivotX.toDouble() - viewWidth.toDouble() / 2.0)
        val newCy = newPivotWy - (pivotY.toDouble() - viewHeight.toDouble() / 2.0)

        centerLon = xToLon(newCx, newWp).coerceIn(22.0, 40.5)
        centerLat = yToLat(newCy, newWp).coerceIn(44.0, 52.5)
        _renderVersion.value++
    }

    fun zoomIn(viewWidth: Float, viewHeight: Float) {
        zoomBy(0.5f, viewWidth / 2f, viewHeight / 2f, viewWidth, viewHeight)
    }

    fun zoomOut(viewWidth: Float, viewHeight: Float) {
        zoomBy(-0.5f, viewWidth / 2f, viewHeight / 2f, viewWidth, viewHeight)
    }

    fun handleTap(x: Float, y: Float, viewWidth: Float, viewHeight: Float) {
        val wp = worldPixels()
        val cx = lonToX(centerLon, wp)
        val cy = latToY(centerLat, wp)

        val tapWx = cx + (x.toDouble() - viewWidth.toDouble() / 2.0)
        val tapWy = cy + (y.toDouble() - viewHeight.toDouble() / 2.0)

        val tapLon = xToLon(tapWx, wp)
        val tapLat = yToLat(tapWy, wp)

        android.util.Log.d("SimplifiedMap", "Tap: lat=$tapLat, lon=$tapLon")

        val tapped = _oblasts.value.find { oblast ->
            val within = tapLat >= oblast.bounds.south && tapLat <= oblast.bounds.north &&
                tapLon >= oblast.bounds.west && tapLon <= oblast.bounds.east
            if (within) {
                android.util.Log.d("SimplifiedMap", "Matched: ${oblast.titleUk}, bounds=${oblast.bounds}")
            }
            within
        }
        android.util.Log.d("SimplifiedMap", "Selected: ${tapped?.titleUk ?: "none"}")
        _selectedOblast.value = tapped
        if (tapped != null) {
            _tapTrigger.value++
        }
    }

    fun geoToScreen(lat: Double, lon: Double, viewWidth: Float, viewHeight: Float): Pair<Float, Float> {
        val wp = worldPixels()
        val cx = lonToX(centerLon, wp)
        val cy = latToY(centerLat, wp)
        val px = lonToX(lon, wp)
        val py = latToY(lat, wp)

        val x = viewWidth / 2f + (px - cx).toFloat()
        val y = viewHeight / 2f + (py - cy).toFloat()
        return x to y
    }

    private fun worldPixels(): Double = 256.0 * 2.0.pow(zoom)

    companion object {
        fun lonToX(lon: Double, wp: Double): Double =
            (lon + 180.0) / 360.0 * wp

        fun latToY(lat: Double, wp: Double): Double {
            val rad = Math.toRadians(lat)
            return (1.0 - ln(tan(rad) + 1.0 / cos(rad)) / PI) / 2.0 * wp
        }

        fun xToLon(x: Double, wp: Double): Double =
            x / wp * 360.0 - 180.0

        fun yToLat(y: Double, wp: Double): Double {
            val a = PI * (1.0 - 2.0 * y / wp)
            return Math.toDegrees(atan(sinh(a)))
        }
    }
}
