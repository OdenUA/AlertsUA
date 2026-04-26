package com.alertsua.app.map.simplified

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import com.alertsua.app.data.ActiveAlertGeometry

class SimplifiedMapRenderer {

    // Active alert (full oblast threat) - red fill
    private val activeFillPaint = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFFD7263D.toInt()
        alpha = 180
        isAntiAlias = true
    }

    // Normal (no threat) - dark theme fill
    private val normalFillPaintDark = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFF2A3A45.toInt() // dark blue-grey
        alpha = 140
        isAntiAlias = true
    }

    // Normal (no threat) - light theme fill
    private val normalFillPaintLight = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFFE8F5E9.toInt() // light green
        alpha = 120
        isAntiAlias = true
    }

    // Border - dark theme (bright for visibility on all backgrounds)
    private val borderPaintDark = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
        color = 0xFFE0E8EC.toInt() // very light grey-white, visible on red/dark
        isAntiAlias = true
    }

    // Border - light theme
    private val borderPaintLight = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
        color = 0xFF37474F.toInt() // dark grey
        isAntiAlias = true
    }

    private val selectedBorderPaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 5f
        color = 0xFF42A5F5.toInt() // bright blue
        isAntiAlias = true
    }

    private val textPaint = Paint().apply {
        style = Paint.Style.FILL
        textSize = 26f
        color = 0xFF212121.toInt()
        isAntiAlias = true
        textAlign = Paint.Align.CENTER
        setTypeface(android.graphics.Typeface.DEFAULT_BOLD)
    }

    private val textPaintDark = Paint().apply {
        style = Paint.Style.FILL
        textSize = 26f
        color = 0xFFE8F5E9.toInt()
        isAntiAlias = true
        textAlign = Paint.Align.CENTER
        setTypeface(android.graphics.Typeface.DEFAULT_BOLD)
    }

    // Oblast center marker - dark theme (orange/amber for visibility on dark bg)
    private val centerMarkerPaintDark = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFFFFB300.toInt() // amber/orange
        isAntiAlias = true
    }

    // Oblast center marker - light theme (dark red for visibility on light bg)
    private val centerMarkerPaintLight = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFFC62828.toInt() // dark red
        isAntiAlias = true
    }

    // Oblast center marker border - dark theme
    private val centerMarkerBorderPaintDark = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
        color = 0xFF000000.toInt() // black
        isAntiAlias = true
    }

    // Oblast center marker border - light theme
    private val centerMarkerBorderPaintLight = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
        color = 0xFFFFFFFF.toInt() // white
        isAntiAlias = true
    }

    // Subscription marker - blue fill
    private val subscriptionMarkerFillPaint = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFF1976D2.toInt() // blue
        isAntiAlias = true
    }

    // Subscription marker - white border
    private val subscriptionMarkerBorderPaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
        color = 0xFFFFFFFF.toInt() // white
        isAntiAlias = true
    }

    // Subscription marker - inner white dot
    private val subscriptionMarkerDotPaint = Paint().apply {
        style = Paint.Style.FILL
        color = 0xFFFFFFFF.toInt() // white
        isAntiAlias = true
    }

    private val markerRadius = 8f

    fun renderOblasts(
        canvas: Canvas,
        oblasts: List<OblastData>,
        projection: (LatLng) -> Pair<Float, Float>,
        isDark: Boolean
    ) {
        val borderPaint = if (isDark) borderPaintDark else borderPaintLight
        val normalFillPaint = if (isDark) normalFillPaintDark else normalFillPaintLight

        for (oblast in oblasts) {
            try {
                val path = createPath(oblast.geometry, projection)

                // 'A' = full alert (red fill), 'P'/'N' = normal (theme-based fill)
                // Partial alerts ('P') show only sub-regions with active alerts via renderActiveAlerts()
                val paint = when (oblast.status.first()) {
                    'A' -> activeFillPaint
                    else -> normalFillPaint
                }

                canvas.drawPath(path, paint)
                canvas.drawPath(path, borderPaint)
            } catch (_: Exception) { }
        }
    }

    fun renderActiveAlerts(
        canvas: Canvas,
        alerts: List<ActiveAlertGeometry>,
        projection: (LatLng) -> Pair<Float, Float>
    ) {
        if (alerts.isEmpty()) return

        val alertPaint = Paint().apply {
            style = Paint.Style.FILL
            color = 0xFFD7263D.toInt()
            alpha = 160
            isAntiAlias = true
        }

        for (alert in alerts) {
            try {
                val path = createPath(alert.geometry, projection)
                canvas.drawPath(path, alertPaint)
            } catch (_: Exception) { }
        }
    }

    fun renderOblastNames(
        canvas: Canvas,
        oblasts: List<OblastData>,
        projection: (LatLng) -> Pair<Float, Float>,
        isDark: Boolean
    ) {
        val paint = if (isDark) textPaintDark else textPaint

        for (oblast in oblasts) {
            try {
                val (x, y) = projection(oblast.center)
                val label = oblast.titleUk.removeSuffix(" область")
                canvas.drawText(label, x, y, paint)
            } catch (_: Exception) { }
        }
    }

    fun renderOblastCenters(
        canvas: Canvas,
        oblasts: List<OblastData>,
        projection: (LatLng) -> Pair<Float, Float>,
        isDark: Boolean
    ) {
        val markerPaint = if (isDark) centerMarkerPaintDark else centerMarkerPaintLight
        val centerMarkerBorderPaint = if (isDark) centerMarkerBorderPaintDark else centerMarkerBorderPaintLight

        for (oblast in oblasts) {
            try {
                val (x, y) = projection(oblast.cityCenter)
                // Draw outer border circle
                canvas.drawCircle(x, y, markerRadius, centerMarkerBorderPaint)
                // Draw inner filled circle
                canvas.drawCircle(x, y, markerRadius - 2.5f, markerPaint)
            } catch (_: Exception) { }
        }
    }

    fun renderSubscriptionMarkers(
        canvas: Canvas,
        pins: List<com.alertsua.app.data.SubscriptionPin>,
        projection: (LatLng) -> Pair<Float, Float>
    ) {
        val markerRadius = 20f
        val innerDotRadius = 8f

        for (pin in pins) {
            try {
                val (x, y) = projection(com.alertsua.app.map.simplified.LatLng(pin.lat, pin.lon))
                // Draw blue circle
                canvas.drawCircle(x, y, markerRadius, subscriptionMarkerFillPaint)
                // Draw white border
                canvas.drawCircle(x, y, markerRadius, subscriptionMarkerBorderPaint)
                // Draw inner white dot
                canvas.drawCircle(x, y, innerDotRadius, subscriptionMarkerDotPaint)
            } catch (_: Exception) { }
        }
    }

    private fun createPath(
        geometry: List<List<List<Double>>>,
        projection: (LatLng) -> Pair<Float, Float>
    ): Path {
        val path = Path()
        for (ring in geometry) {
            if (ring.isEmpty()) continue
            val (firstX, firstY) = projection(LatLng(ring[0][1], ring[0][0]))
            path.moveTo(firstX, firstY)
            for (i in 1 until ring.size) {
                val (x, y) = projection(LatLng(ring[i][1], ring[i][0]))
                path.lineTo(x, y)
            }
            path.close()
        }
        return path
    }
}
