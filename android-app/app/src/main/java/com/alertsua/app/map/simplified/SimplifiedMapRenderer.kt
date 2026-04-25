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
