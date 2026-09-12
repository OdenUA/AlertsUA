package com.alertsua.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.util.Log
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.sqrt

/**
 * Данные для Compose-попапа угрозы (порт buildThreatPopupContent из utils.js:
 * sender по каналу, текст сообщения, время, жизненный цикл).
 */
data class ThreatInfo(
    val overlayId: String,
    val channelRef: String,
    val sender: String,
    val messageText: String,
    val messageTimeMs: Long,
    val occurredAtMs: Long,
    val totalLifetimeMs: Long,
)

/**
 * Нативный порт threat-engine.js: загрузка GET {apiBase}/map/threat-overlays
 * (polling 60 сек, пауза в фоне), фильтрация по каналу/времени жизни,
 * слои area-fill/area-line/direction-line/direction-arrow/icons на MapLibre.
 *
 * Данные держатся в памяти; при смене стиля карты слои пересоздаются
 * без повторного сетевого запроса. Z-order: угрозы поверх occupied/alert-fill,
 * но под пинами подписок (это обеспечивает MapController.onBaseLayersReinstalled).
 */
class ThreatLayersManager(
    private val appContext: Context,
    private val mapController: MapController,
) {
    companion object {
        const val CHANNEL_DEFAULT = "@kpszsu"
        const val CHANNEL_WAR_MONITOR = "@war_monitor"

        // Порт THREAT_CHANNEL_CONFIG из constants.js (sender per channel)
        val CHANNEL_SENDERS = mapOf(
            CHANNEL_DEFAULT to "Повітряні Сили ЗС України",
            CHANNEL_WAR_MONITOR to "War Monitor",
        )

        private const val LAYER_DIRECTION_LINE = "threat-direction-line"
        private const val LAYER_DIRECTION_ARROW = "threat-direction-arrow"
        private const val LAYER_ICONS = "threat-icons"

        private const val SOURCE_DIRECTIONS = "src-threat-directions"
        private const val SOURCE_ARROWS = "src-threat-arrows"
        private const val SOURCE_ICONS = "src-threat-icons"

        private const val IMAGE_DIRECTION_ARROW = "threat-direction-arrow-icon"
        private const val IMAGE_THREAT_PREFIX = "threat-icon-"

        private const val POLL_INTERVAL_MS = 60_000L

        // Окно видимости (renderThreatOverlays / buildThreatLifetimeMarkup)
        private const val UAV_VISIBLE_MS = 45 * 60 * 1000L
        private const val DEFAULT_VISIBLE_MS = 30 * 60 * 1000L

        // Порт THREAT_DIRECTION_* из constants.js
        private const val DIRECTION_MIN_DISTANCE_METERS = 10_000.0
        private const val DIRECTION_ARC_SEGMENTS = 18
        private const val DIRECTION_ARC_MIN_OFFSET_PX = 12.0
        private const val DIRECTION_ARC_MAX_OFFSET_PX = 30.0
        private const val DIRECTION_ZOOM_BASE = 7
        private const val DIRECTION_ZOOM_SCALE_STEP = 0.18
        private const val DIRECTION_BASE_LINE_WEIGHT = 2.5f
        private const val DIRECTION_BASE_ARROW_LENGTH_PX = 12f
        private const val DIRECTION_ARROW_WIDTH_PX = 6f

        // THREAT_MARKER_TAP_TARGET_PX / 2
        private const val TAP_TOLERANCE_DP = 20f
        private const val THREAT_ICON_SIZE_DP = 28f

        // Кластеризация иконок: если расстояние между маркерами меньше
        // CLUSTER_MIN_SEP_FACTOR * размерИконки — объединяем в одну иконку.
        // 0.3 = только иконки, которые визуально накладываются друг на друга
        private const val CLUSTER_MIN_SEP_FACTOR = 0.3f

        private val COLOR_DIRECTION = Color.parseColor("#4285f4")

        // Максимальная широта Web-Mercator (как в Leaflet SphericalMercator)
        private const val MAX_MERCATOR_LAT = 85.05112878
    }

    var apiBaseUrl: String = ""
        private set
    var darkMode: Boolean = false
        private set

    private var map: MapLibreMap? = null
    private var style: Style? = null
    private var layersInstalled = false

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loadJob: Job? = null
    private var pollJob: Job? = null
    private var lastFetchAtMs = 0L

    init {
        // Первичный fetch не зависит от карты/стиля — стартуем сразу
        MapPerf.log("ThreatLayers", "manager created, starting overlays fetch")
        loadJob = scope.launch { fetchAndRender() }
    }

    private var overlays: List<ThreatOverlay> = emptyList()
    private var visibleOverlays: List<ThreatOverlay> = emptyList()
    private var activeChannel: String? = CHANNEL_DEFAULT
    // Кластер: representative overlayId → список оверлеев в кластере
    private var clusterMap: Map<String, List<ThreatOverlay>> = emptyMap()

    private data class ThreatOverlay(
        val overlayId: String,
        val threatKind: String,
        val iconType: String,
        val occurredAtMs: Long,
        val expiresAtMs: Long,
        val messageText: String?,
        val messageDateMs: Long,
        val sourceExcerpt: String?,
        val channelRef: String?,
        val movementBearingDeg: Double?,
        val markerLat: Double,
        val markerLng: Double,
        val corridor: List<Point>?,
    ) {
        val hasMarker: Boolean get() = !markerLat.isNaN() && !markerLng.isNaN()

        // overlay.threat_kind || overlay.icon_type || 'unknown'
        val effectiveKind: String
            get() = threatKind.takeIf { it.isNotBlank() }
                ?: iconType.takeIf { it.isNotBlank() }
                ?: "unknown"

        // (source_excerpt || message_text) && message_date — попап есть только у таких
        val hasPopup: Boolean
            get() = (!sourceExcerpt.isNullOrBlank() || !messageText.isNullOrBlank()) && messageDateMs > 0
    }

    // ── Attach / detach ──────────────────────────────────────────────────────

    fun onMapReady(map: MapLibreMap) {
        this.map = map
        map.addOnCameraIdleListener(cameraIdleListener)
        if (loadJob?.isActive != true &&
            SystemClock.elapsedRealtime() - lastFetchAtMs > POLL_INTERVAL_MS
        ) {
            loadJob = scope.launch { fetchAndRender() }
        }
    }

    fun onStyleLoaded(style: Style) {
        // Слои могли быть установлены заранее через reinstallLayers(style) из
        // хука AlertLayersManager — тогда повторная установка не нужна.
        if (this.style === style && layersInstalled) return
        this.style = style
        layersInstalled = false
        installLayers()
    }

    fun detach() {
        pollJob?.cancel()
        loadJob?.cancel()
        map?.removeOnCameraIdleListener(cameraIdleListener)
        map = null
        style = null
        layersInstalled = false
    }

    fun updateConfig(apiBaseUrl: String, darkMode: Boolean) {
        val baseChanged = this.apiBaseUrl != apiBaseUrl
        this.apiBaseUrl = apiBaseUrl
        this.darkMode = darkMode
        // Первичный fetch уже делает init — не дублируем запрос
        if (baseChanged && loadJob?.isActive != true &&
            SystemClock.elapsedRealtime() - lastFetchAtMs > POLL_INTERVAL_MS
        ) {
            refreshNow()
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    fun onHostStart() {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            // Первичный fetch уже делает loadJob (init) — не дублируем запрос
            if (loadJob?.isActive != true &&
                SystemClock.elapsedRealtime() - lastFetchAtMs > POLL_INTERVAL_MS
            ) {
                fetchAndRender()
            }
            while (isActive) {
                delay(POLL_INTERVAL_MS)
                fetchAndRender()
            }
        }
    }

    fun onHostStop() {
        pollJob?.cancel()
        pollJob = null
    }

    fun refreshNow() {
        scope.launch { fetchAndRender() }
    }

    /**
     * Смена активного канала — только перерендер из кэша, без сети
     * (порт setThreatChannel: null скрывает слой полностью).
     */
    fun setThreatChannel(channelRef: String?) {
        activeChannel = channelRef
        renderFromCache()
    }

    // ── Пересчёт геометрии направлений по окончании движения камеры ─────────
    // (аналог zoomend в threat-engine.js: дуга/стрелка считаются в пикселях
    // текущего зума, поэтому после зума геометрию нужно перестроить)

    private val cameraIdleListener = MapLibreMap.OnCameraIdleListener { onCameraIdle() }

    private fun onCameraIdle() {
        val style = this.style ?: return
        if (!layersInstalled) return
        if (style.getSource(SOURCE_DIRECTIONS) == null) return

        // Пересчитываем кластеры при новом зуме (minSepPx зависит от iconScale)
        val clusters = computeClusters(visibleOverlays)
        clusterMap = clusters.associateBy({ it.first().overlayId }, { it })

        val directionFeatures = ArrayList<Feature>()
        val arrowFeatures = ArrayList<Feature>()
        val iconFeatures = ArrayList<Feature>()
        clusters.forEach { cluster ->
            buildClusterIconFeature(cluster)?.let(iconFeatures::add)
        }
        visibleOverlays.forEach { buildDirection(it, directionFeatures, arrowFeatures) }

        style.getSourceAs<GeoJsonSource>(SOURCE_DIRECTIONS)
            ?.setGeoJson(FeatureCollection.fromFeatures(directionFeatures))
        style.getSourceAs<GeoJsonSource>(SOURCE_ARROWS)
            ?.setGeoJson(FeatureCollection.fromFeatures(arrowFeatures))
        style.getSourceAs<GeoJsonSource>(SOURCE_ICONS)
            ?.setGeoJson(FeatureCollection.fromFeatures(iconFeatures))
        Log.d("ThreatLayers", "camera idle: rebuilt at zoom=${currentZoom()} " +
            "(clusters=${clusters.size}, dirs=${directionFeatures.size}, arrows=${arrowFeatures.size})")
    }

    // ── Hit test (тап по угрозе) ─────────────────────────────────────────────

    /** Возвращает список ThreatInfo при попадании в иконку угрозы (кластер), иначе пустой список. */
    fun hitTest(latLng: LatLng): List<ThreatInfo> {
        val map = this.map ?: return emptyList()
        val style = this.style ?: return emptyList()
        if (activeChannel == null) return emptyList()
        if (style.getLayer(LAYER_ICONS) == null) return emptyList()

        val density = appContext.resources.displayMetrics.density
        val screen = map.projection.toScreenLocation(latLng)
        val r = TAP_TOLERANCE_DP * density
        val rect = RectF(screen.x - r, screen.y - r, screen.x + r, screen.y + r)
        val hits = map.queryRenderedFeatures(rect, LAYER_ICONS)
        // Интерактивны только угрозы с попапом (как hitMarker в JS)
        val hit = hits.firstOrNull { it.getBooleanProperty("has_popup") } ?: return emptyList()
        val overlayId = hit.getStringProperty("overlay_id") ?: return emptyList()
        // Ищем кластер по representative overlayId
        val cluster = clusterMap[overlayId]
        if (cluster != null) {
            return cluster
                .sortedByDescending { it.occurredAtMs }
                .map { it.toThreatInfo() }
        }
        // Фолбэк: одиночный оверлей
        val overlay = visibleOverlays.firstOrNull { it.overlayId == overlayId } ?: return emptyList()
        return listOf(overlay.toThreatInfo())
    }

    private fun ThreatOverlay.toThreatInfo(): ThreatInfo {
        val channel = channelRef ?: CHANNEL_DEFAULT
        // Порт buildThreatLifetimeMarkup: expires_at, если валиден, иначе окно по виду
        val totalMs = if (expiresAtMs > occurredAtMs) {
            expiresAtMs - occurredAtMs
        } else {
            if (threatKind == "uav") UAV_VISIBLE_MS else DEFAULT_VISIBLE_MS
        }
        return ThreatInfo(
            overlayId = overlayId,
            channelRef = channel,
            sender = CHANNEL_SENDERS[channel] ?: CHANNEL_SENDERS.getValue(CHANNEL_DEFAULT),
            messageText = sourceExcerpt?.takeIf { it.isNotBlank() } ?: messageText.orEmpty(),
            messageTimeMs = if (messageDateMs > 0) messageDateMs else occurredAtMs,
            occurredAtMs = occurredAtMs,
            totalLifetimeMs = totalMs,
        )
    }

    // ── Fetch ────────────────────────────────────────────────────────────────

    private suspend fun fetchAndRender() {
        if (!awaitApiBase()) return
        val fetched = withContext(Dispatchers.IO) {
            runCatching { fetchOverlays() }
                .onFailure { Log.w("ThreatLayers", "Threat overlays fetch failed: ${it.message}") }
                .getOrNull()
        }
        lastFetchAtMs = SystemClock.elapsedRealtime()
        if (fetched != null) {
            overlays = fetched
            MapPerf.log("ThreatLayers", "overlays fetched: ${fetched.size}")
        }
        // Рендерим даже при неудачном fetch: протухшие по времени должны исчезать
        renderFromCache()
    }

    // apiBaseUrl приходит из SideEffect чуть позже конструктора — ждём его
    private suspend fun awaitApiBase(): Boolean {
        var attempts = 0
        while (apiBaseUrl.isEmpty() && attempts < 100) {
            delay(50)
            attempts++
        }
        return apiBaseUrl.isNotEmpty()
    }

    private fun fetchOverlays(): List<ThreatOverlay> {
        // Как и JS: запрашиваем все каналы, фильтрация по каналу — клиентская
        val sources = CHANNEL_SENDERS.keys.joinToString(",") { URLEncoder.encode(it, "UTF-8") }
        val url = apiBaseUrl.trimEnd('/') + "/map/threat-overlays?sources=" + sources
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Accept", "application/json")
            connection.useCaches = false
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            val text = connection.inputStream.bufferedReader().use { it.readText() }
            return parseOverlays(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun parseOverlays(text: String): List<ThreatOverlay> {
        val root = JSONObject(text)
        val array = root.optJSONArray("overlays") ?: return emptyList()
        val result = ArrayList<ThreatOverlay>(array.length())
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val marker = parseMarkerPoint(o.optJSONObject("marker"))
            val bearing = o.optDouble("movement_bearing_deg", Double.NaN)
                .takeIf { !it.isNaN() }
            result += ThreatOverlay(
                overlayId = o.optString("overlay_id"),
                threatKind = o.optString("threat_kind"),
                iconType = o.optString("icon_type"),
                occurredAtMs = parseBackendTimeMs(o.optString("occurred_at")),
                expiresAtMs = parseBackendTimeMs(o.optString("expires_at")),
                messageText = o.optString("message_text").takeIf { it.isNotBlank() },
                messageDateMs = parseBackendTimeMs(o.optString("message_date")),
                sourceExcerpt = o.optString("source_excerpt").takeIf { it.isNotBlank() },
                channelRef = o.optString("channel_ref").takeIf { it.isNotBlank() },
                movementBearingDeg = bearing,
                markerLat = marker?.first ?: Double.NaN,
                markerLng = marker?.second ?: Double.NaN,
                corridor = parseCorridor(o.optJSONObject("corridor")),
            )
        }
        return result
    }

    private fun parseMarkerPoint(json: JSONObject?): Pair<Double, Double>? {
        if (json == null || json.optString("type") != "Point") return null
        val coords = json.optJSONArray("coordinates") ?: return null
        if (coords.length() < 2) return null
        val lng = coords.optDouble(0, Double.NaN)
        val lat = coords.optDouble(1, Double.NaN)
        if (lat.isNaN() || lng.isNaN()) return null
        return lat to lng
    }

    private fun parseCorridor(json: JSONObject?): List<Point>? {
        if (json == null || json.optString("type") != "LineString") return null
        val coords = json.optJSONArray("coordinates") ?: return null
        if (coords.length() < 2) return null
        val points = ArrayList<Point>(coords.length())
        for (i in 0 until coords.length()) {
            val pair = coords.optJSONArray(i) ?: continue
            if (pair.length() < 2) continue
            val lng = pair.optDouble(0, Double.NaN)
            val lat = pair.optDouble(1, Double.NaN)
            if (lat.isNaN() || lng.isNaN()) continue
            points += Point.fromLngLat(lng, lat)
        }
        return if (points.size >= 2) points else null
    }

    // Сервер отдаёт occurred_at::text вида "2025-01-31 14:23:45.123+02";
    // если смещения нет — считаем Europe/Kyiv (как остальной backend-контракт).
    private val tzOffsetHoursOnly = Regex("([+-]\\d{2})$")
    private val tzOffsetCompact = Regex("([+-]\\d{2})(\\d{2})$")

    private fun parseBackendTimeMs(raw: String?): Long {
        if (raw.isNullOrBlank()) return -1L
        val normalized = raw.trim()
            .replace(' ', 'T')
            .replace(tzOffsetHoursOnly, "$1:00")
            .replace(tzOffsetCompact, "$1:$2")
        return runCatching { OffsetDateTime.parse(normalized).toInstant().toEpochMilli() }
            .recoverCatching {
                LocalDateTime.parse(normalized)
                    .atZone(ZoneId.of("Europe/Kyiv"))
                    .toInstant()
                    .toEpochMilli()
            }
            .getOrDefault(-1L)
    }

    // ── Visibility (порт фильтров renderThreatOverlays) ──────────────────────

    private fun isVisibleByTime(o: ThreatOverlay, now: Long): Boolean {
        if (o.occurredAtMs <= 0) return false
        if (o.expiresAtMs > 0 && now < o.expiresAtMs) return true
        val maxVisibleMs = if (o.threatKind == "uav") UAV_VISIBLE_MS else DEFAULT_VISIBLE_MS
        return now < o.occurredAtMs + maxVisibleMs
    }

    private fun filterVisible(now: Long): List<ThreatOverlay> {
        val channel = activeChannel ?: return emptyList()
        return overlays.filter { o ->
            isVisibleByTime(o, now) && (o.channelRef ?: CHANNEL_DEFAULT) == channel
        }
    }

    // ── Layer installation ───────────────────────────────────────────────────

    /**
     * Переустановка слоёв поверх свежедобавленных базовых (alert-fill/occupied).
     * Вызывается из MapController после установки AlertLayersManager.
     */
    internal fun reinstallLayers(style: Style) {
        this.style = style
        if (layersInstalled) removeLayers(style)
        layersInstalled = false
        installLayers()
    }

    private fun removeLayers(style: Style) {
        listOf(LAYER_DIRECTION_LINE, LAYER_DIRECTION_ARROW, LAYER_ICONS)
            .forEach { if (style.getLayer(it) != null) style.removeLayer(it) }
        listOf(SOURCE_DIRECTIONS, SOURCE_ARROWS, SOURCE_ICONS)
            .forEach { if (style.getSource(it) != null) style.removeSource(it) }
    }

    private fun installLayers() {
        val style = this.style ?: return
        if (layersInstalled) return

        installImages(style)

        val data = buildRenderData(System.currentTimeMillis())
        visibleOverlays = data.visible

        style.addSource(GeoJsonSource(SOURCE_DIRECTIONS, FeatureCollection.fromFeatures(data.directionFeatures)))
        style.addLayer(LineLayer(LAYER_DIRECTION_LINE, SOURCE_DIRECTIONS).withProperties(
            PropertyFactory.lineColor(COLOR_DIRECTION),
            PropertyFactory.lineOpacity(0.85f),
            PropertyFactory.lineWidth(directionLineWidth()),
            PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
            PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
        ))

        style.addSource(GeoJsonSource(SOURCE_ARROWS, FeatureCollection.fromFeatures(data.arrowFeatures)))
        style.addLayer(SymbolLayer(LAYER_DIRECTION_ARROW, SOURCE_ARROWS).withProperties(
            PropertyFactory.iconImage(IMAGE_DIRECTION_ARROW),
            PropertyFactory.iconRotate(Expression.get("bearing")),
            PropertyFactory.iconSize(directionArrowSize()),
            PropertyFactory.iconAllowOverlap(true),
            PropertyFactory.iconIgnorePlacement(true),
        ))

        style.addSource(GeoJsonSource(SOURCE_ICONS, FeatureCollection.fromFeatures(data.iconFeatures)))
        style.addLayer(SymbolLayer(LAYER_ICONS, SOURCE_ICONS).withProperties(
            PropertyFactory.iconImage(Expression.get("icon")),
            PropertyFactory.iconRotate(Expression.get("bearing")),
            PropertyFactory.iconSize(threatIconSize()),
            PropertyFactory.iconAllowOverlap(true),
            PropertyFactory.iconIgnorePlacement(true),
        ))

        layersInstalled = true
        MapPerf.log("ThreatLayers", "threat layers installed (visible=${data.visible.size})")
    }

    private fun renderFromCache() {
        val style = this.style ?: return
        if (!layersInstalled) {
            installLayers()
            return
        }
        val data = buildRenderData(System.currentTimeMillis())
        visibleOverlays = data.visible
        style.getSourceAs<GeoJsonSource>(SOURCE_DIRECTIONS)
            ?.setGeoJson(FeatureCollection.fromFeatures(data.directionFeatures))
        style.getSourceAs<GeoJsonSource>(SOURCE_ARROWS)
            ?.setGeoJson(FeatureCollection.fromFeatures(data.arrowFeatures))
        style.getSourceAs<GeoJsonSource>(SOURCE_ICONS)
            ?.setGeoJson(FeatureCollection.fromFeatures(data.iconFeatures))
    }

    // Толщина линии направления: getThreatDirectionStyle →
    // clamp(2.5 * (1 + (zoom-7) * 0.18), 1.5, 3.5); в диапазоне zoom 5..9
    // clamp не срабатывает, поэтому стопов по целым зумам достаточно.
    private fun directionLineWidth(): Expression {
        fun weightAt(zoom: Int): Float {
            val scale = 1 + (zoom - DIRECTION_ZOOM_BASE) * DIRECTION_ZOOM_SCALE_STEP
            return (DIRECTION_BASE_LINE_WEIGHT * scale).toFloat().coerceIn(1.5f, 3.5f)
        }
        return Expression.interpolate(
            Expression.linear(), Expression.zoom(),
            Expression.stop(5f, weightAt(5)),
            Expression.stop(6f, weightAt(6)),
            Expression.stop(7f, weightAt(7)),
            Expression.stop(8f, weightAt(8)),
            Expression.stop(9f, weightAt(9)),
        )
    }

    // Размер стрелки: clamp(12 * zoomScale, 8, 16) px при базе zoom 7 → iconSize
    private fun directionArrowSize(): Expression {
        fun sizeAt(zoom: Int): Float {
            val scale = 1 + (zoom - DIRECTION_ZOOM_BASE) * DIRECTION_ZOOM_SCALE_STEP
            val px = (DIRECTION_BASE_ARROW_LENGTH_PX * scale).toFloat().coerceIn(8f, 16f)
            return px / DIRECTION_BASE_ARROW_LENGTH_PX
        }
        return Expression.interpolate(
            Expression.linear(), Expression.zoom(),
            Expression.stop(5f, sizeAt(5)),
            Expression.stop(6f, sizeAt(6)),
            Expression.stop(7f, sizeAt(7)),
            Expression.stop(8f, sizeAt(8)),
            Expression.stop(9f, sizeAt(9)),
        )
    }

    // Размер иконки угрозы (makeThreatIcon): zoom<=5 → 0.6, zoom<=6 → 0.78, дальше 1.0
    private fun threatIconSize(): Expression = Expression.interpolate(
        Expression.linear(), Expression.zoom(),
        Expression.stop(5f, 0.6f),
        Expression.stop(6f, 0.78f),
        Expression.stop(7f, 1.0f),
    )

    // ── Render data ──────────────────────────────────────────────────────────

    private class RenderData(
        val visible: List<ThreatOverlay>,
        val directionFeatures: List<Feature>,
        val arrowFeatures: List<Feature>,
        val iconFeatures: List<Feature>,
    )

    private fun buildRenderData(now: Long): RenderData {
        val visible = filterVisible(now)
        val clusters = computeClusters(visible)
        clusterMap = clusters.associateBy({ it.first().overlayId }, { it })

        val directionFeatures = ArrayList<Feature>()
        val arrowFeatures = ArrayList<Feature>()
        val iconFeatures = ArrayList<Feature>()

        // Одна иконка на кластер (representative = самый свежий)
        clusters.forEach { cluster ->
            buildClusterIconFeature(cluster)?.let(iconFeatures::add)
        }

        // Линии направления — для каждого оверлея (включая все в кластере)
        visible.forEach { o ->
            buildDirection(o, directionFeatures, arrowFeatures)
        }

        return RenderData(visible, directionFeatures, arrowFeatures, iconFeatures)
    }

    /**
     * Группирует иконки которые визуально накладываются.
     * Сравнение — с якорем (первой иконкой) кластера, без дрейфа центроида.
     * Только иконки в пределах minSepPx от якоря попадают в кластер.
     */
    private fun computeClusters(overlays: List<ThreatOverlay>): List<List<ThreatOverlay>> {
        val withMarker = overlays.filter { it.hasMarker }
        if (withMarker.isEmpty()) return emptyList()

        val zoom = currentZoom()
        val worldSize = 256.0 * 2.0.pow(zoom)
        val density = appContext.resources.displayMetrics.density
        val iconScale = when {
            zoom <= 5.0 -> 0.6f
            zoom <= 6.0 -> 0.78f
            else -> 1.0f
        }
        val minSepPx = (THREAT_ICON_SIZE_DP * density * iconScale * CLUSTER_MIN_SEP_FACTOR).toDouble()

        data class Cluster(
            val members: MutableList<ThreatOverlay>,
            val anchorPx: Double,
            val anchorPy: Double,
        )
        val clusters = mutableListOf<Cluster>()

        for (o in withMarker) {
            val p = projectToPx(o.markerLat, o.markerLng, worldSize)
            val px = p[0]
            val py = p[1]

            // Ищем ближайший якорь в пределах minSepPx
            var best: Cluster? = null
            var bestDist = Double.MAX_VALUE
            for (c in clusters) {
                val dist = hypot(px - c.anchorPx, py - c.anchorPy)
                if (dist < minSepPx && dist < bestDist) {
                    bestDist = dist
                    best = c
                }
            }

            if (best != null) {
                best.members.add(o)
            } else {
                clusters.add(Cluster(mutableListOf(o), px, py))
            }
        }

        return clusters.map { c ->
            c.members.sortByDescending { it.occurredAtMs }
            c.members
        }
    }

    /** Одна иконка на кластер: representative = самый свежий оверлей */
    private fun buildClusterIconFeature(cluster: List<ThreatOverlay>): Feature? {
        val rep = cluster.first()
        if (!rep.hasMarker) return null
        val props = JsonObject().apply {
            addProperty("icon", IMAGE_THREAT_PREFIX + iconVariantKey(rep.effectiveKind))
            addProperty("bearing", resolveIconBearing(rep) ?: 0.0)
            addProperty("overlay_id", rep.overlayId)
            addProperty("has_popup", cluster.any { it.hasPopup })
        }
        return Feature.fromGeometry(Point.fromLngLat(rep.markerLng, rep.markerLat), props)
    }

    private fun iconVariantKey(kind: String): String = when (kind) {
        "uav", "kab", "missile" -> kind
        else -> "unknown"
    }

    // Порт addThreatDirectionIndicator: дуга Безье marker → конец коридора +
    // стрелка в точке цели. Геометрия считается в «пикселях» Web-Mercator при
    // ТЕКУЩЕМ зуме камеры и перестраивается по OnCameraIdle (zoomend в JS).
    private fun buildDirection(
        o: ThreatOverlay,
        directionFeatures: MutableList<Feature>,
        arrowFeatures: MutableList<Feature>,
    ) {
        val corridor = o.corridor ?: return
        if (!o.hasMarker) return
        val start = corridor.first()
        val end = corridor.last()
        if (start.latitude() == end.latitude() && start.longitude() == end.longitude()) return
        if (distanceMeters(o.markerLat, o.markerLng, end.latitude(), end.longitude()) <= DIRECTION_MIN_DISTANCE_METERS) return

        val zoom = currentZoom()
        val zoomScale = 1 + (zoom - DIRECTION_ZOOM_BASE) * DIRECTION_ZOOM_SCALE_STEP
        val worldSize = 256.0 * 2.0.pow(zoom)

        val startPx = projectToPx(o.markerLat, o.markerLng, worldSize)
        val targetPx = projectToPx(end.latitude(), end.longitude(), worldSize)
        val deltaX = targetPx[0] - startPx[0]
        val deltaY = targetPx[1] - startPx[1]
        val distancePx = hypot(deltaX, deltaY)
        if (distancePx < 1) return

        // Дуга стартует из центра угрозы (без отступа): иконка угрозы рисуется
        // поверх (LAYER_ICONS добавлен последним) и перекрывает начало линии.
        val curveStartX = startPx[0]
        val curveStartY = startPx[1]
        val curveDeltaX = targetPx[0] - curveStartX
        val curveDeltaY = targetPx[1] - curveStartY
        val curveDistancePx = hypot(curveDeltaX, curveDeltaY)
        if (curveDistancePx < 1) return

        val perpX = -curveDeltaY / curveDistancePx
        val perpY = curveDeltaX / curveDistancePx
        val midX = (curveStartX + targetPx[0]) / 2
        val midY = (curveStartY + targetPx[1]) / 2
        val arcOffsetPx = max(
            DIRECTION_ARC_MIN_OFFSET_PX * zoomScale,
            min(DIRECTION_ARC_MAX_OFFSET_PX * zoomScale, curveDistancePx * 0.14),
        )
        val controlX = midX + perpX * arcOffsetPx
        val controlY = midY + perpY * arcOffsetPx

        // Порт createQuadraticBezierPoints
        val geoPoints = (0..DIRECTION_ARC_SEGMENTS).map { index ->
            val t = index.toDouble() / DIRECTION_ARC_SEGMENTS
            val mt = 1 - t
            val px = mt * mt * curveStartX + 2 * mt * t * controlX + t * t * targetPx[0]
            val py = mt * mt * curveStartY + 2 * mt * t * controlY + t * t * targetPx[1]
            unprojectFromPx(px, py, worldSize)
        }
        if (geoPoints.size < 2) return

        directionFeatures += Feature.fromGeometry(LineString.fromLngLats(geoPoints))

        // Стрелка: в точке цели, поворот по направлению конца дуги
        val tip = geoPoints.last()
        val directionPoint = geoPoints[max(0, geoPoints.size - 3)]
        val arrowBearing = calculateBearingDegrees(
            directionPoint.latitude(), directionPoint.longitude(),
            tip.latitude(), tip.longitude(),
        )
        arrowFeatures += Feature.fromGeometry(
            tip,
            JsonObject().apply { addProperty("bearing", arrowBearing) },
        )
    }

    private fun currentZoom(): Double =
        map?.cameraPosition?.zoom?.takeIf { it > 0 } ?: DIRECTION_ZOOM_BASE.toDouble()

    // ── Bearing (порт geometry.js / resolveThreatBearing / makeThreatIcon) ───

    private fun normalizeBearingDegrees(value: Double?): Double? {
        if (value == null || value.isNaN()) return null
        var normalized = value % 360
        if (normalized < 0) normalized += 360
        return normalized
    }

    private fun calculateBearingDegrees(
        startLat: Double, startLng: Double,
        endLat: Double, endLng: Double,
    ): Double {
        val startLatRad = Math.toRadians(startLat)
        val endLatRad = Math.toRadians(endLat)
        val deltaLngRad = Math.toRadians(endLng - startLng)
        val y = sin(deltaLngRad) * cos(endLatRad)
        val x = cos(startLatRad) * sin(endLatRad) -
            sin(startLatRad) * cos(endLatRad) * cos(deltaLngRad)
        return normalizeBearingDegrees(Math.toDegrees(atan2(y, x))) ?: 0.0
    }

    private fun corridorBearing(o: ThreatOverlay): Double? {
        val corridor = o.corridor ?: return null
        val start = corridor.first()
        val end = corridor.last()
        if (start.latitude() == end.latitude() && start.longitude() == end.longitude()) return null
        return calculateBearingDegrees(start.latitude(), start.longitude(), end.latitude(), end.longitude())
    }

    private fun resolveThreatBearing(o: ThreatOverlay): Double? {
        val explicit = normalizeBearingDegrees(o.movementBearingDeg)
        val corridor = corridorBearing(o)
        if (corridor == null) return explicit
        if (explicit == null) return corridor
        val difference = Math.abs(explicit - corridor)
        val shortest = min(difference, 360 - difference)
        if (explicit == 0.0 && shortest > 1) return corridor
        return explicit
    }

    private fun hasDistinctCorridor(o: ThreatOverlay): Boolean {
        val corridor = o.corridor ?: return false
        val start = corridor.first()
        val end = corridor.last()
        return start.latitude() != end.latitude() || start.longitude() != end.longitude()
    }

    // makeThreatIcon: KAB-иконка нативно смотрит на юго-запад (225°) —
    // докручиваем +135°, только если есть коридор с различными точками.
    private fun resolveIconBearing(o: ThreatOverlay): Double? {
        var angle = resolveThreatBearing(o)
        if (o.effectiveKind == "kab" && angle != null && hasDistinctCorridor(o)) {
            angle = (angle + 135) % 360
        }
        return angle
    }

    // ── Web-Mercator при текущем зуме (аналог map.project/unproject в JS) ────

    private fun projectToPx(lat: Double, lng: Double, worldSize: Double): DoubleArray {
        val clampedLat = lat.coerceIn(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
        val sinLat = sin(Math.toRadians(clampedLat))
        val x = (lng + 180.0) / 360.0 * worldSize
        val y = (0.5 - 0.25 * ln((1 + sinLat) / (1 - sinLat)) / Math.PI) * worldSize
        return doubleArrayOf(x, y)
    }

    private fun unprojectFromPx(x: Double, y: Double, worldSize: Double): Point {
        val lng = x / worldSize * 360.0 - 180.0
        val lat = Math.toDegrees(atan(sinh(Math.PI * (1 - 2 * y / worldSize))))
        return Point.fromLngLat(lng, lat)
    }

    // Leaflet distanceTo (R = 6371000)
    private fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val radius = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
            sin(dLng / 2) * sin(dLng / 2)
        return 2 * radius * atan2(sqrt(a), sqrt(1 - a))
    }

    // ── Images ───────────────────────────────────────────────────────────────

    private fun installImages(style: Style) {
        if (style.getImage(IMAGE_DIRECTION_ARROW) == null) {
            style.addImage(IMAGE_DIRECTION_ARROW, createDirectionArrowBitmap())
        }
        // Порт THREAT_TYPE_ICONS: вариант light/dark по теме. При смене темы
        // стиль пересоздаётся целиком, поэтому подмена происходит на новом стиле.
        listOf("uav", "kab", "missile", "unknown").forEach { kind ->
            val name = IMAGE_THREAT_PREFIX + kind
            if (style.getImage(name) != null) return@forEach
            val bitmap = loadScaledIcon(threatIconAssetPath(kind, darkMode), THREAT_ICON_SIZE_DP)
                ?: return@forEach
            style.addImage(name, bitmap)
        }
    }

    private fun threatIconAssetPath(kind: String, dark: Boolean): String = when (kind) {
        "uav" -> if (dark) "map/icons/shahed-dark.png" else "map/icons/shahed-light.png"
        "kab" -> if (dark) "map/icons/kab-grey.png" else "map/icons/kab-black.png"
        "missile" -> if (dark) "map/icons/missile-grey.png" else "map/icons/missile-black.png"
        else -> "map/icons/air-raid.png"
    }

    private fun loadScaledIcon(path: String, sizeDp: Float): Bitmap? {
        val density = appContext.resources.displayMetrics.density
        val raw = runCatching {
            appContext.assets.open(path).use { BitmapFactory.decodeStream(it) }
        }.getOrNull() ?: return null
        val target = (sizeDp * density).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(raw, target, target, true)
    }

    // Треугольник-стрелка (в JS — L.polygon в конце дуги): остриё вверх (bearing 0),
    // длина 12dp, полуширина 6dp, поворот — через icon-rotate.
    private fun createDirectionArrowBitmap(): Bitmap {
        val density = appContext.resources.displayMetrics.density
        val width = (DIRECTION_ARROW_WIDTH_PX * 2 * density).roundToInt().coerceAtLeast(1)
        val height = (DIRECTION_BASE_ARROW_LENGTH_PX * density).roundToInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val path = Path().apply {
            moveTo(width / 2f, 0f)
            lineTo(width.toFloat(), height.toFloat())
            lineTo(0f, height.toFloat())
            close()
        }
        canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = COLOR_DIRECTION })
        return bitmap
    }
}
