package com.alertsua.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.util.Log
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.FillLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Geometry
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

/**
 * Нативный порт alert-layers.js / static-geometry.js / occupied-territories.js /
 * map-initialization.js (маска): статичная GeoJSON-геометрия из assets +
 * статусы тривог из GET {apiBase}/map/bundle, периодический опрос раз в 30 сек.
 *
 * Производительность холодного старта: слои НЕ парсятся в объектный граф gson
 * (FeatureCollection.fromJson на 1.4MB hromada занимал ~6 с на эмуляторе) —
 * в GeoJsonSource отдаётся «сырая» GeoJSON-строка (нативный парс в C++),
 * а статусы инжектятся стриминговой трансформацией JSON (JsonReader→JsonWriter)
 * на фоновом диспетчере. Центры фич для иконок спец-тривог и названия для
 * поиска Киева берутся из прегенерированного layer-meta.json
 * (android-app/scripts/generate-layer-meta.js).
 *
 * При смене стиля карты слои пересоздаются без повторного чтения assets/сети.
 */
class AlertLayersManager(
    private val appContext: Context,
    private val mapController: MapController,
) {
    companion object {
        const val LAYER_MASK_FILL = "ua-mask"
        const val LAYER_MASK_BORDER = "ua-mask-border"
        const val LAYER_OBLAST_BORDERS = "oblast-borders"
        const val LAYER_FILL_OBLAST = "alert-fill-oblast"
        const val LAYER_FILL_RAION = "alert-fill-raion"
        const val LAYER_FILL_HROMADA = "alert-fill-hromada"
        const val LAYER_FILL_SPECIAL = "alert-fill-special"
        const val LAYER_OBLAST_STATUS_BORDERS = "oblast-status-borders"
        const val LAYER_OCCUPIED_FILL = "occupied-fill"
        const val LAYER_OCCUPIED_HATCH = "occupied-hatch"
        const val LAYER_OCCUPIED_LINE = "occupied-line"
        const val LAYER_ALERT_TYPE_ICONS = "alert-type-icons"

        private const val SOURCE_MASK = "src-ua-mask"
        private const val SOURCE_OBLAST = "src-oblast"
        private const val SOURCE_RAION = "src-raion"
        private const val SOURCE_HROMADA = "src-hromada"
        private const val SOURCE_OCCUPIED = "src-occupied"
        private const val SOURCE_ALERT_ICONS = "src-alert-icons"

        private const val IMAGE_OCCUPIED_HATCH = "occupied-hatch"
        private const val IMAGE_ICON_PREFIX = "alert-icon-"

        private const val STATUS_POLL_INTERVAL_MS = 30_000L

        private val COLOR_MASK_FILL_LIGHT = Color.parseColor("#e8f0f4")
        private val COLOR_MASK_FILL_DARK = Color.parseColor("#131e28")
        private val COLOR_MASK_BORDER_LIGHT = Color.parseColor("#91afc0")
        private val COLOR_MASK_BORDER_DARK = Color.parseColor("#2a4258")
        private val COLOR_OBLAST_BORDER = Color.parseColor("#5a7d8e")
        private val COLOR_OBLAST_STATUS_BORDER_IDLE = Color.parseColor("#4d7a8a")
        private val COLOR_OCCUPIED = Color.parseColor("#dc2626")

        private val DEFAULT_STATUS = StatusInfo(" ", "air_raid", "red")
    }

    var apiBaseUrl: String = ""
        private set
    var darkMode: Boolean = false
        private set

    private var map: MapLibreMap? = null
    private var style: Style? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loadJob: Job? = null
    private var pollJob: Job? = null

    init {
        // Парсинг статической геометрии стартует сразу при создании менеджера,
        // не дожидаясь onMapReady/стиля (тяжёлая работа — на IO-диспетчере).
        MapPerf.log("AlertLayers", "manager created, starting geometry load")
        loadJob = scope.launch { loadGeometryAndStatuses() }
    }

    private var geometryLoaded = false
    private var initialStatusesApplied = false
    private var appliedStateVersion: Long = -1
    private var lastFetchAtMs = 0L
    private var layersInstalledForStyle: Style? = null

    // «Сырые» FeatureCollection-строки: pristine (из assets) и со встроенными
    // status/alert_type/alert_level (результат инъекции, отдаётся в источники)
    private var oblastRawJson = ""
    private var raionRawJson = ""
    private var hromadaRawJson = ""
    private var oblastJson = ""
    private var raionJson = ""
    private var hromadaJson = ""
    private var occupiedCollectionJson: String? = null
    private var maskFeature: Feature? = null

    internal var ukraineBoundaryGeometry: Geometry? = null
        private set

    // uid → метаданные фичи (из layer-meta.json)
    private data class MetaEntry(val titleUk: String, val regionType: String, val center: Point?)

    private var layerMeta: Map<String, Map<String, MetaEntry>> = emptyMap()
    private var kyivOblastUid: String? = null
    private var kyivCityUid: String? = null

    // Эффективные статусы по uid (после наследования м. Київ)
    private data class StatusInfo(val status: String, val alertType: String, val alertLevel: String)

    private var resolvedStatuses: Map<String, StatusInfo> = emptyMap()

    // ── Attach / detach ──────────────────────────────────────────────────────

    fun onMapReady(map: MapLibreMap) {
        this.map = map
        if (loadJob?.isActive != true && !geometryLoaded) {
            loadJob = scope.launch { loadGeometryAndStatuses() }
        }
    }

    fun onStyleLoaded(style: Style) {
        this.style = style
        installLayersIfReady()
    }

    fun detach() {
        pollJob?.cancel()
        loadJob?.cancel()
        map = null
        style = null
        layersInstalledForStyle = null
    }

    fun updateConfig(apiBaseUrl: String, darkMode: Boolean) {
        val baseChanged = this.apiBaseUrl != apiBaseUrl
        this.apiBaseUrl = apiBaseUrl
        this.darkMode = darkMode
        if (baseChanged && initialStatusesApplied &&
            SystemClock.elapsedRealtime() - lastFetchAtMs > STATUS_POLL_INTERVAL_MS
        ) {
            appliedStateVersion = -1
            refreshStatusesNow()
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    fun onHostStart() {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            // Первичный fetch уже делает loadJob (init) — не дублируем запрос
            val fetchedRecently = SystemClock.elapsedRealtime() - lastFetchAtMs < STATUS_POLL_INTERVAL_MS
            if (geometryLoaded && loadJob?.isActive != true && !fetchedRecently) {
                fetchAndApplyStatuses(notifyOnChange = true)
            }
            while (isActive) {
                delay(STATUS_POLL_INTERVAL_MS)
                fetchAndApplyStatuses(notifyOnChange = true)
            }
        }
    }

    fun onHostStop() {
        pollJob?.cancel()
        pollJob = null
    }

    /** Немедленное обновление статусов (MapController.refreshAlerts) с фидбеком. */
    fun refreshStatusesNow() {
        scope.launch {
            if (apiBaseUrl.isEmpty()) {
                mapController.onToast("Сервер недоступний")
                return@launch
            }
            val bundle = withContext(Dispatchers.IO) {
                runCatching { fetchBundle() }
                    .onFailure { Log.w("AlertLayers", "Manual refresh fetch failed: ${it.message}") }
                    .getOrNull()
            }
            if (bundle == null) {
                mapController.onToast("Помилка оновлення")
                return@launch
            }
            lastFetchAtMs = SystemClock.elapsedRealtime()
            val (stateVersion, lookup) = bundle
            if (stateVersion == appliedStateVersion) {
                mapController.onToast("Дані вже актуальні")
                return@launch
            }
            applyStatusBundle(stateVersion, lookup, notifyOnChange = false)
            mapController.onToast("Статуси тривог оновлено")
        }
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    private suspend fun loadGeometryAndStatuses() {
        // Чтение/нормализация GeoJSON и сетевой запрос бандла идут параллельно
        val geometryDeferred = scope.async(Dispatchers.IO) {
            runCatching { loadStaticGeometry() }
                .onFailure { Log.e("AlertLayers", "Failed to load static geometry", it) }
        }
        val bundleDeferred = scope.async(Dispatchers.IO) {
            if (!awaitApiBase()) return@async null
            runCatching { fetchBundle() }
                .onFailure { Log.w("AlertLayers", "Status bundle fetch failed: ${it.message}") }
                .getOrNull()
        }

        geometryDeferred.await()
        geometryLoaded = true
        MapPerf.log("AlertLayers", "static geometry loaded")

        bundleDeferred.await()?.let { (stateVersion, lookup) ->
            lastFetchAtMs = SystemClock.elapsedRealtime()
            applyStatusBundle(stateVersion, lookup, notifyOnChange = false)
        }
        installLayersIfReady()
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

    private suspend fun loadStaticGeometry() {
        // Читаем три слоя параллельно (каждый read — UTF-8 decode, CPU-bound);
        // boundary/occupied тоже в параллель
        val oblastDeferred = scope.async(Dispatchers.IO) { readLayerAssetRaw("map/data/oblast.geojson") }
        val raionDeferred = scope.async(Dispatchers.IO) { readLayerAssetRaw("map/data/raion.geojson") }
        val hromadaDeferred = scope.async(Dispatchers.IO) { readLayerAssetRaw("map/data/hromada.geojson") }
        val boundaryDeferred = scope.async(Dispatchers.IO) {
            val boundaryJson = JSONObject(readAsset("map/data/ukraine-boundary.geojson"))
            boundaryJson.optJSONObject("feature")?.let { Feature.fromJson(it.toString()) }
        }
        val occupiedDeferred = scope.async(Dispatchers.IO) {
            normalizeOccupied(readAsset("map/data/occupied-territories.geojson"))
        }
        oblastRawJson = oblastDeferred.await()
        raionRawJson = raionDeferred.await()
        hromadaRawJson = hromadaDeferred.await()
        oblastJson = oblastRawJson
        raionJson = raionRawJson
        hromadaJson = hromadaRawJson
        loadLayerMeta()

        val boundaryFeature = boundaryDeferred.await()
        if (boundaryFeature != null) {
            ukraineBoundaryGeometry = boundaryFeature.geometry()
            maskFeature = buildMaskFeature(ukraineBoundaryGeometry)
        }
        occupiedCollectionJson = occupiedDeferred.await()
    }

    // Assets хранят {"layer":...,"features":[...]} без type — собираем
    // FeatureCollection строковой вставкой (парс делает нативный GeoJsonSource).
    private fun readLayerAssetRaw(path: String): String {
        val t0 = SystemClock.elapsedRealtime()
        val rawText = readAsset(path)
        val result = run {
            val featuresKey = rawText.indexOf("\"features\"")
            if (featuresKey >= 0) {
                val arrayStart = rawText.indexOf('[', featuresKey + 10)
                if (arrayStart >= 0 && rawText.trimEnd().endsWith("]}")) {
                    return@run "{\"type\":\"FeatureCollection\",\"features\":" +
                        rawText.substring(arrayStart)
                }
            }
            val raw = JSONObject(rawText)
            JSONObject()
                .put("type", "FeatureCollection")
                .put("features", raw.getJSONArray("features"))
                .toString()
        }
        MapPerf.log("AlertLayers", "read ${path.substringAfterLast('/')}: " +
            "${SystemClock.elapsedRealtime() - t0} ms (${rawText.length / 1024} KB)")
        return result
    }

    private fun loadLayerMeta() {
        val raw = JSONObject(readAsset("map/data/layer-meta.json"))
        val result = HashMap<String, Map<String, MetaEntry>>()
        listOf("oblast", "raion", "hromada").forEach { layerKey ->
            val layerJson = raw.optJSONObject(layerKey) ?: return@forEach
            val entries = HashMap<String, MetaEntry>()
            val uids = layerJson.keys()
            while (uids.hasNext()) {
                val uid = uids.next()
                val entry = layerJson.optJSONObject(uid) ?: continue
                val centerJson = entry.optJSONArray("c")
                val center = if (centerJson != null && centerJson.length() >= 2) {
                    Point.fromLngLat(centerJson.optDouble(0), centerJson.optDouble(1))
                } else null
                entries[uid] = MetaEntry(
                    titleUk = entry.optString("t"),
                    regionType = entry.optString("r"),
                    center = center,
                )
            }
            result[layerKey] = entries
        }
        layerMeta = result

        // Киев и Киевская область — city-фича и oblast-фича в oblast-слое
        val oblastMeta = result["oblast"].orEmpty()
        kyivOblastUid = oblastMeta.entries.firstOrNull { (_, meta) ->
            meta.regionType == "oblast" && normalizeRegionTitle(meta.titleUk) == "київська область"
        }?.key
        kyivCityUid = oblastMeta.entries.firstOrNull { (_, meta) ->
            if (meta.regionType != "city") return@firstOrNull false
            normalizeRegionTitle(meta.titleUk) in KYIV_CITY_TITLES
        }?.key
        Log.d("AlertLayers", "layer-meta loaded: oblastUid=$kyivOblastUid, kyivCityUid=$kyivCityUid")
    }

    // readBytes + однопроходный UTF-8 decode строкой заметно быстрее
    // Reader.readText() на холодном старте (до JIT)
    private fun readAsset(path: String): String =
        String(appContext.assets.open(path).use { it.readBytes() }, Charsets.UTF_8)

    // {feature|geojson|FeatureCollection|Feature|Geometry} → FeatureCollection JSON
    private fun normalizeOccupied(rawText: String): String? {
        return runCatching {
            val raw = JSONObject(rawText)
            val normalized = when {
                raw.has("feature") -> raw.getJSONObject("feature")
                raw.has("geojson") -> raw.getJSONObject("geojson")
                else -> raw
            }
            when (normalized.optString("type")) {
                "FeatureCollection" -> normalized.toString()
                "Feature" -> JSONObject()
                    .put("type", "FeatureCollection")
                    .put("features", JSONArray().put(normalized))
                    .toString()
                else -> JSONObject()
                    .put("type", "FeatureCollection")
                    .put("features", JSONArray().put(JSONObject()
                        .put("type", "Feature")
                        .put("properties", JSONObject())
                        .put("geometry", normalized)))
                    .toString()
            }
        }.onFailure { Log.e("AlertLayers", "Failed to normalize occupied territories", it) }.getOrNull()
    }

    // Порт buildMaskFeature из map-initialization.js: мир с дырами по кольцам границы
    private fun buildMaskFeature(boundary: Geometry?): Feature? {
        val worldRing = listOf(
            Point.fromLngLat(-180.0, -90.0),
            Point.fromLngLat(180.0, -90.0),
            Point.fromLngLat(180.0, 90.0),
            Point.fromLngLat(-180.0, 90.0),
            Point.fromLngLat(-180.0, -90.0),
        )
        val outerRings: List<List<Point>> = when (boundary) {
            is Polygon -> listOf(boundary.coordinates()[0])
            is MultiPolygon -> boundary.coordinates().map { it[0] }
            else -> emptyList()
        }
        if (outerRings.isEmpty()) return null
        // Дыры должны иметь обратную обходку относительно внешнего кольца
        val holes = outerRings.map { it.reversed() }
        return Feature.fromGeometry(Polygon.fromLngLats(listOf(worldRing) + holes))
    }

    // ── Status bundle ────────────────────────────────────────────────────────

    private suspend fun fetchAndApplyStatuses(notifyOnChange: Boolean) {
        if (apiBaseUrl.isEmpty()) return
        val bundle = withContext(Dispatchers.IO) {
            runCatching { fetchBundle() }
                .onFailure { Log.w("AlertLayers", "Status bundle fetch failed: ${it.message}") }
                .getOrNull()
        } ?: return
        lastFetchAtMs = SystemClock.elapsedRealtime()

        applyStatusBundle(bundle.first, bundle.second, notifyOnChange)
    }

    private suspend fun applyStatusBundle(
        stateVersion: Long,
        lookup: Map<String, StatusInfo>,
        notifyOnChange: Boolean,
    ) {
        if (stateVersion == appliedStateVersion) return
        appliedStateVersion = stateVersion

        val changed = resolveStatuses(lookup)
        // Инъекция статусов в pristine GeoJSON-строки (быстрый строковый проход)
        val injected = withContext(Dispatchers.Default) {
            val statuses = resolvedStatuses
            Triple(
                injectStatuses(oblastRawJson, statuses),
                injectStatuses(raionRawJson, statuses),
                injectStatuses(hromadaRawJson, statuses),
            )
        }
        oblastJson = injected.first
        raionJson = injected.second
        hromadaJson = injected.third
        MapPerf.log("AlertLayers", "statuses injected into geojson")
        pushStatusesToSources()
        MapPerf.log("AlertLayers", "statuses pushed to sources")

        val wasInitial = !initialStatusesApplied
        initialStatusesApplied = true
        if (wasInitial) {
            MapPerf.log("AlertLayers", "statuses applied (state_version=$stateVersion, lookup=${lookup.size})")
        }

        if (notifyOnChange && !wasInitial && changed > 0) {
            mapController.onToast("Статуси тривог оновлено")
        }
    }

    private fun fetchBundle(): Pair<Long, Map<String, StatusInfo>> {
        val url = apiBaseUrl.trimEnd('/') + "/map/bundle"
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Accept", "application/json")
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            val text = connection.inputStream.bufferedReader().use { it.readText() }

            val json = JSONObject(text)
            val stateVersion = json.optLong("state_version", 0)
            val lookup = mutableMapOf<String, StatusInfo>()
            val lookupJson = json.optJSONObject("status_lookup")
            if (lookupJson != null) {
                val keys = lookupJson.keys()
                while (keys.hasNext()) {
                    val uid = keys.next()
                    val info = lookupJson.optJSONObject(uid) ?: continue
                    lookup[uid] = StatusInfo(
                        status = info.optString("status", " "),
                        alertType = info.optString("alert_type", "air_raid"),
                        alertLevel = info.optString("alert_level", "red"),
                    )
                }
            }
            return stateVersion to lookup
        } finally {
            connection.disconnect()
        }
    }

    // Порт applyBundleStatuses + applyKyivCityInheritedOblastStatus из
    // static-geometry.js: эффективный статус по uid = статус из бандла
    // (или ' ' если региона нет в lookup); м. Київ наследует статус Киевской
    // области, если у города нет собственной активной тривоги.
    // Возвращает количество фич, у которых реально изменился статус.
    private fun resolveStatuses(lookup: Map<String, StatusInfo>): Int {
        val previous = resolvedStatuses
        val resolved = HashMap<String, StatusInfo>()
        layerMeta.forEach { (_, entries) ->
            entries.keys.forEach { uid ->
                resolved[uid] = lookup[uid] ?: DEFAULT_STATUS
            }
        }

        val oblastUid = kyivOblastUid
        val cityUid = kyivCityUid
        if (oblastUid != null && cityUid != null) {
            val oblastInfo = resolved[oblastUid] ?: DEFAULT_STATUS
            val cityInfo = resolved[cityUid] ?: DEFAULT_STATUS
            val effective = if (cityInfo.status == "A") cityInfo else oblastInfo
            Log.d("AlertLayers", "Kyiv inheritance: oblast=${oblastInfo.status} " +
                "city=${cityInfo.status} -> effective=${effective.status}")
            resolved[cityUid] = effective
        }

        resolvedStatuses = resolved

        var changed = 0
        resolved.forEach { (uid, info) ->
            if ((previous[uid] ?: DEFAULT_STATUS) != info) changed++
        }
        return changed
    }

    // ── Инъекция статусов в GeoJSON-строку ───────────────────────────────────
    // Assets генерируются машинно и компактны: каждая фича содержит
    // "properties":{"uid":<число>,...} без пробелов и вложенных объектов.
    // Вставляем status/alert_type/alert_level сразу после "{" properties
    // одним проходом по строке (без полной токенизации JSON).

    private fun injectStatuses(rawJson: String, statuses: Map<String, StatusInfo>): String {
        if (rawJson.isEmpty()) return rawJson
        val marker = "\"properties\":{\"uid\":"
        val propsStartOffset = "\"properties\":{".length
        val out = StringBuilder(rawJson.length + 65536)
        var i = 0
        while (i < rawJson.length) {
            val idx = rawJson.indexOf(marker, i)
            if (idx < 0) {
                out.append(rawJson, i, rawJson.length)
                break
            }
            val propsStart = idx + propsStartOffset
            val uidStart = idx + marker.length
            var uidEnd = uidStart
            while (uidEnd < rawJson.length && rawJson[uidEnd].isDigit()) uidEnd++
            out.append(rawJson, i, propsStart)
            if (uidEnd > uidStart) {
                val info = statuses[rawJson.substring(uidStart, uidEnd)] ?: DEFAULT_STATUS
                out.append("\"status\":\"").append(info.status)
                    .append("\",\"alert_type\":\"").append(info.alertType)
                    .append("\",\"alert_level\":\"").append(info.alertLevel)
                    .append("\",")
            }
            i = propsStart
        }
        return out.toString()
    }

    private fun normalizeRegionTitle(value: String?): String =
        (value ?: "").lowercase().replace(Regex("\\s+"), " ").trim()

    // ── Layer installation ───────────────────────────────────────────────────

    private fun installLayersIfReady() {
        val style = this.style ?: return
        if (!geometryLoaded) return
        if (layersInstalledForStyle === style) return
        val installStart = SystemClock.elapsedRealtime()

        style.addImage(IMAGE_OCCUPIED_HATCH, createOccupiedHatchBitmap())
        installAlertTypeIcons(style)

        maskFeature?.let { mask ->
            style.addSource(GeoJsonSource(SOURCE_MASK, mask))
            style.addLayer(FillLayer(LAYER_MASK_FILL, SOURCE_MASK).withProperties(
                PropertyFactory.fillColor(if (darkMode) COLOR_MASK_FILL_DARK else COLOR_MASK_FILL_LIGHT),
                PropertyFactory.fillOpacity(1.0f),
            ))
            style.addLayer(LineLayer(LAYER_MASK_BORDER, SOURCE_MASK).withProperties(
                PropertyFactory.lineColor(if (darkMode) COLOR_MASK_BORDER_DARK else COLOR_MASK_BORDER_LIGHT),
                PropertyFactory.lineWidth(1.8f),
            ))
        }

        if (oblastJson.isNotEmpty()) style.addSource(GeoJsonSource(SOURCE_OBLAST, oblastJson))
        if (raionJson.isNotEmpty()) style.addSource(GeoJsonSource(SOURCE_RAION, raionJson))
        if (hromadaJson.isNotEmpty()) style.addSource(GeoJsonSource(SOURCE_HROMADA, hromadaJson))

        style.addLayer(LineLayer(LAYER_OBLAST_BORDERS, SOURCE_OBLAST).withProperties(
            PropertyFactory.lineColor(COLOR_OBLAST_BORDER),
            PropertyFactory.lineWidth(2.5f),
        ))

        addAlertFillLayer(style, LAYER_FILL_OBLAST, SOURCE_OBLAST, statusActiveFilter())
        addAlertFillLayer(style, LAYER_FILL_RAION, SOURCE_RAION, statusActiveFilter())
        addAlertFillLayer(style, LAYER_FILL_HROMADA, SOURCE_HROMADA, statusActiveFilter())
        addAlertFillLayer(style, LAYER_FILL_SPECIAL, SOURCE_HROMADA, specialActiveFilter())

        style.addLayer(LineLayer(LAYER_OBLAST_STATUS_BORDERS, SOURCE_OBLAST).withProperties(
            PropertyFactory.lineColor(oblastStatusBorderColor()),
            PropertyFactory.lineWidth(2.5f),
        ).apply { setFilter(Expression.eq(Expression.get("region_type"), Expression.literal("oblast"))) })

        occupiedCollectionJson?.let { json ->
            style.addSource(GeoJsonSource(SOURCE_OCCUPIED, json))
            style.addLayer(FillLayer(LAYER_OCCUPIED_FILL, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.fillColor(COLOR_OCCUPIED),
                PropertyFactory.fillOpacity(if (darkMode) 0.08f else 0.05f),
            ))
            style.addLayer(FillLayer(LAYER_OCCUPIED_HATCH, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.fillPattern(IMAGE_OCCUPIED_HATCH),
            ))
            style.addLayer(LineLayer(LAYER_OCCUPIED_LINE, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.lineColor(COLOR_OCCUPIED),
                PropertyFactory.lineWidth(2.5f),
                PropertyFactory.lineOpacity(0.9f),
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
            ))
        }

        style.addSource(GeoJsonSource(SOURCE_ALERT_ICONS, FeatureCollection.fromFeatures(buildIconFeatures())))
        style.addLayer(SymbolLayer(LAYER_ALERT_TYPE_ICONS, SOURCE_ALERT_ICONS).withProperties(
            PropertyFactory.iconImage(Expression.get("icon")),
            PropertyFactory.iconSize(1.0f),
            PropertyFactory.iconAllowOverlap(true),
            PropertyFactory.iconIgnorePlacement(true),
        ))

        // Слои угроз и пины подписок должны оставаться поверх базовых —
        // контроллер переустановит их при необходимости (z-order).
        mapController.onBaseLayersReinstalled(style)
        layersInstalledForStyle = style
        MapPerf.log("AlertLayers", "alert layers installed (install took " +
            "${SystemClock.elapsedRealtime() - installStart} ms)")
    }

    private fun addAlertFillLayer(style: Style, layerId: String, sourceId: String, filter: Expression) {
        style.addLayer(FillLayer(layerId, sourceId).withProperties(
            PropertyFactory.fillColor(alertFillColor()),
            PropertyFactory.fillOpacity(alertFillOpacity()),
        ).apply { setFilter(filter) })
    }

    private fun statusActiveFilter(): Expression =
        Expression.eq(Expression.get("status"), Expression.literal("A"))

    private fun specialActiveFilter(): Expression = Expression.all(
        statusActiveFilter(),
        Expression.any(
            Expression.eq(Expression.get("alert_type"), Expression.literal("artillery_shelling")),
            Expression.eq(Expression.get("alert_type"), Expression.literal("urban_fights")),
        ),
    )

    // Порт getAlertPalette (fill): спец-типы сохраняют свои цвета,
    // air_raid красится по уровню угрозы (red/yellow)
    private fun alertFillColor(): Expression = Expression.switchCase(
        Expression.eq(Expression.get("alert_type"), Expression.literal("artillery_shelling")),
        Expression.color(Color.parseColor("#ffb347")),
        Expression.eq(Expression.get("alert_type"), Expression.literal("urban_fights")),
        Expression.color(Color.parseColor("#b47aea")),
        Expression.eq(Expression.get("alert_level"), Expression.literal("yellow")),
        Expression.color(Color.parseColor("#ecea50")),
        Expression.color(Color.parseColor("#d7263d")),
    )

    private fun alertFillOpacity(): Expression = Expression.switchCase(
        Expression.eq(Expression.get("alert_type"), Expression.literal("artillery_shelling")),
        Expression.literal(0.42f),
        Expression.eq(Expression.get("alert_type"), Expression.literal("urban_fights")),
        Expression.literal(0.45f),
        Expression.eq(Expression.get("alert_level"), Expression.literal("yellow")),
        Expression.literal(0.32f),
        Expression.literal(0.25f),
    )

    // Порт stroke-палитры: граница области окрашивается при статусе A/P
    private fun oblastStatusBorderColor(): Expression {
        val alertColor = Expression.switchCase(
            Expression.eq(Expression.get("alert_type"), Expression.literal("artillery_shelling")),
            Expression.color(Color.parseColor("#f08c00")),
            Expression.eq(Expression.get("alert_type"), Expression.literal("urban_fights")),
            Expression.color(Color.parseColor("#7b2cbf")),
            Expression.eq(Expression.get("alert_level"), Expression.literal("yellow")),
            Expression.color(Color.parseColor("#997f3e")),
            Expression.color(Color.parseColor("#d7263d")),
        )
        return Expression.switchCase(
            Expression.eq(Expression.get("status"), Expression.literal("A")), alertColor,
            Expression.eq(Expression.get("status"), Expression.literal("P")), alertColor,
            Expression.color(COLOR_OBLAST_STATUS_BORDER_IDLE),
        )
    }

    private fun pushStatusesToSources() {
        val style = this.style ?: return
        if (style.getLayer(LAYER_FILL_OBLAST) == null) return
        style.getSourceAs<GeoJsonSource>(SOURCE_OBLAST)?.setGeoJson(oblastJson)
        style.getSourceAs<GeoJsonSource>(SOURCE_RAION)?.setGeoJson(raionJson)
        style.getSourceAs<GeoJsonSource>(SOURCE_HROMADA)?.setGeoJson(hromadaJson)
        style.getSourceAs<GeoJsonSource>(SOURCE_ALERT_ICONS)
            ?.setGeoJson(FeatureCollection.fromFeatures(buildIconFeatures()))
    }

    // ── Alert type icons ─────────────────────────────────────────────────────

    private fun buildIconFeatures(): List<Feature> {
        val result = mutableListOf<Feature>()
        fun collect(layerKey: String, onlyUid: String? = null) {
            val entries = layerMeta[layerKey] ?: return
            entries.forEach { (uid, meta) ->
                if (onlyUid != null && uid != onlyUid) return@forEach
                val info = resolvedStatuses[uid] ?: return@forEach
                if (info.status != "A") return@forEach
                if (info.alertType != "artillery_shelling" && info.alertType != "urban_fights") return@forEach
                val center = meta.center ?: return@forEach
                result.add(Feature.fromGeometry(
                    center,
                    JsonObject().apply {
                        addProperty("icon", IMAGE_ICON_PREFIX + info.alertType)
                    },
                ))
            }
        }
        collect("hromada")
        // м. Київ есть только в oblast-слое (в hromada-слое её нет) —
        // в спецслой её добавляем отдельно
        kyivCityUid?.let { collect("oblast", onlyUid = it) }
        return result
    }

    private fun installAlertTypeIcons(style: Style) {
        val density = appContext.resources.displayMetrics.density
        mapOf(
            "air_raid" to "map/icons/air-raid.png",
            "artillery_shelling" to "map/icons/artillery-shelling.png",
            "urban_fights" to "map/icons/urban-fights.png",
        ).forEach { (alertType, path) ->
            val bitmap = loadScaledIcon(path, 24f, density) ?: return@forEach
            style.addImage(IMAGE_ICON_PREFIX + alertType, bitmap)
        }
    }

    private fun loadScaledIcon(path: String, sizeDp: Float, density: Float): Bitmap? {
        val raw = runCatching {
            appContext.assets.open(path).use { BitmapFactory.decodeStream(it) }
        }.getOrNull() ?: return null
        val target = (sizeDp * density).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(raw, target, target, true)
    }

    // Диагональная штриховка оккупированных территорий (порт OccupiedHatchLayer)
    private fun createOccupiedHatchBitmap(): Bitmap {
        val density = appContext.resources.displayMetrics.density
        val tile = (10f * density).roundToInt().coerceAtLeast(10)
        val bitmap = Bitmap.createBitmap(tile, tile, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb((0.45f * 255).roundToInt(), 220, 38, 38)
            style = Paint.Style.STROKE
            strokeWidth = 1.5f * density
            strokeCap = Paint.Cap.BUTT
        }
        canvas.drawLine(-1f, -1f, tile + 1f, tile + 1f, paint)
        return bitmap
    }

    private val KYIV_CITY_TITLES = setOf("київ", "м. київ", "м київ")
}
