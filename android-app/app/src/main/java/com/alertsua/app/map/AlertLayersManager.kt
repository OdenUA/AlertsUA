package com.alertsua.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.gson.JsonObject
import com.alertsua.app.net.Http
import com.alertsua.app.notifications.AlertUpdateBus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
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
import org.maplibre.android.style.layers.Layer
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
import kotlin.math.roundToInt

/**
 * Эффективный статус региона после resolveStatuses: статус из бандла
 * ('A' / 'P' / ' ') + тип и уровень тривоги (red/yellow).
 * Читается баннером текущей громады через statusForUid().
 */
data class AlertStatusInfo(val status: String, val alertType: String, val alertLevel: String)

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
        private const val SOURCE_OBLAST_LABELS = "src-oblast-labels"
        private const val LAYER_OBLAST_LABELS = "oblast-city-labels"

        private const val IMAGE_OCCUPIED_HATCH = "occupied-hatch"
        private const val IMAGE_ICON_PREFIX = "alert-icon-"

        private const val STATUS_POLL_INTERVAL_MS = 30_000L

        // Порог «только что обновлялись» для ре-фетча при возврате на экран
        private const val ON_START_REFETCH_THRESHOLD_MS = 10_000L

        private val COLOR_MASK_FILL_LIGHT = Color.parseColor("#e8f0f4")
        private val COLOR_MASK_FILL_DARK = Color.parseColor("#131e28")
        private val COLOR_MASK_BORDER_LIGHT = Color.parseColor("#91afc0")
        private val COLOR_MASK_BORDER_DARK = Color.parseColor("#2a4258")
        private val COLOR_OBLAST_BORDER = Color.parseColor("#5a7d8e")
        private val COLOR_OBLAST_STATUS_BORDER_IDLE = Color.parseColor("#4d7a8a")
        private val COLOR_OCCUPIED = Color.parseColor("#dc2626")

        private val DEFAULT_STATUS = AlertStatusInfo(" ", "air_raid", "red")

        // uid → короткое название области (без слова «область») для подписей на карте
        private val OBLAST_CITY_NAMES: Map<String, String> = mapOf(
            "3" to "Хмельницька",
            "4" to "Вінницька",
            "5" to "Рівненська",
            "8" to "Волинська",
            "9" to "Дніпропетровська",
            "10" to "Житомирська",
            "11" to "Закарпатська",
            "12" to "Запорізька",
            "13" to "Івано-Франківська",
            "14" to "Київська",
            "15" to "Кіровоградська",
            "16" to "Луганська",
            "17" to "Миколаївська",
            "18" to "Одеська",
            "19" to "Полтавська",
            "20" to "Сумська",
            "21" to "Тернопільська",
            "22" to "Харківська",
            "23" to "Херсонська",
            "24" to "Черкаська",
            "25" to "Чернігівська",
            "26" to "Чернівецька",
            "27" to "Львівська",
            "28" to "Донецька",
            "29" to "АР Крим",
            // "31" (м. Київ) не включаем — уже отображается в стандартном городском слое
        )
    }

    var apiBaseUrl: String = ""
        private set
    var darkMode: Boolean = false
        private set

    private var map: MapLibreMap? = null
    private var style: Style? = null

    /**
     * Стиль, безопасный для чтения sources/layers. При смене темы map.setStyle()
     * сбрасывает fullyLoaded у прежнего объекта Style, и любой getSource/getLayer
     * на нём бросает IllegalStateException ("a newer style is loading/has loaded").
     * Все обращения к стилю — на главном потоке, как и setStyle, поэтому проверки
     * fullyLoaded перед синхронным доступом достаточно.
     */
    private fun usableStyle(): Style? = style?.takeIf { it.isFullyLoaded }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loadJob: Job? = null
    private var pollJob: Job? = null
    private var busJob: Job? = null

    // Хост (карта) на экране? В свёрнутом приложении FCM-пуш не должен
    // гонять fetch + инъекцию 1.6 МБ статусов и показывать системный тост
    // поверх лаунчера (как это делает ThreatLayersManager).
    @Volatile private var hostStarted = false

    // Пуш пришёл, пока приложение было свёрнуто: догоняющий fetch в onHostStart
    @Volatile private var pendingPushRefresh = false

    init {
        // Парсинг статической геометрии стартует сразу при создании менеджера,
        // не дожидаясь onMapReady/стиля (тяжёлая работа — на IO-диспетчере).
        MapPerf.log("AlertLayers", "manager created, starting geometry load")
        loadJob = scope.launch { loadGeometryAndStatuses() }
        // FCM-пуш → немедленное обновление статусов, не дожидаясь тика poll
        busJob = scope.launch {
            AlertUpdateBus.updates.collect {
                if (!hostStarted) {
                    pendingPushRefresh = true
                    return@collect
                }
                if (!geometryLoaded) return@collect
                runCatching { fetchAndApplyStatuses(notifyOnChange = true) }
                    .onFailure { Log.w("AlertLayers", "Push-triggered refresh failed: ${it.message}") }
            }
        }
    }

    private var geometryLoaded = false
    private var initialStatusesApplied = false
    private var appliedStateVersion: Long = -1
    private var lastFetchAtMs = 0L

    // Прогрессивная установка слоёв: oblast встаёт первым (первый осмысленный
    // кадр карты), raion/hromada доустанавливаются по мере чтения geojson.
    private var oblastReady = false
    private var raionReady = false
    private var hromadaReady = false
    private var baseLayersInstalled = false
    private var raionLayerInstalled = false
    private var hromadaLayersInstalled = false

    // Якорь z-order: id нижнего SymbolLayer подложки с name-подписями.
    // Заливки тревог встают ПОД него — иначе полупрозрачная заливка
    // (жёлтый/красный уровень) рисуется поверх подписей и приглушает текст.
    private var baseLabelAnchorId: String? = null

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
    private var resolvedStatuses: Map<String, AlertStatusInfo> = emptyMap()

    /** Баннер текущей громады: статус конкретного uid (null — нет в lookup). */
    fun statusForUid(uid: String): AlertStatusInfo? = resolvedStatuses[uid]

    // Вызывается после каждого успешного применения статусов (poll / FCM /
    // ручной refresh / первичная загрузка) — баннер перечитывает statusForUid
    var onStatusesApplied: (() -> Unit)? = null

    // ── Attach / detach ──────────────────────────────────────────────────────

    fun onMapReady(map: MapLibreMap) {
        this.map = map
        if (loadJob?.isActive != true && !geometryLoaded) {
            loadJob = scope.launch { loadGeometryAndStatuses() }
        }
    }

    fun onStyleLoaded(style: Style) {
        this.style = style
        // Новый стиль (старт/смена темы) — все фазы ставим заново
        baseLayersInstalled = false
        raionLayerInstalled = false
        hromadaLayersInstalled = false
        resolveBaseLabelAnchor(style)
        installLayersIfReady()
    }

    fun detach() {
        pollJob?.cancel()
        loadJob?.cancel()
        busJob?.cancel()
        onStatusesApplied = null
        map = null
        style = null
        baseLayersInstalled = false
        raionLayerInstalled = false
        hromadaLayersInstalled = false
        // Отменяем весь scope: незакрытый коллектор AlertUpdateBus удерживал
        // менеджер (и ~3.3 МБ geojson-строк) навсегда — по паре менеджеров
        // утекало на каждое открытие Настроек/поворот экрана.
        scope.cancel()
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
        hostStarted = true
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            // Первичный fetch уже делает loadJob (init) — не дублируем запрос;
            // но пуш, пришедший в свёрнутом приложении, догоняем сразу
            val fetchedRecently = SystemClock.elapsedRealtime() - lastFetchAtMs < ON_START_REFETCH_THRESHOLD_MS
            if (geometryLoaded && loadJob?.isActive != true && (!fetchedRecently || pendingPushRefresh)) {
                pendingPushRefresh = false
                runCatching { fetchAndApplyStatuses(notifyOnChange = true) }
                    .onFailure { Log.w("AlertLayers", "Status poll tick failed: ${it.message}") }
            }
            while (isActive) {
                delay(STATUS_POLL_INTERVAL_MS)
                // Одно исключение в тике не должно убивать pollJob навсегда
                runCatching { fetchAndApplyStatuses(notifyOnChange = true) }
                    .onFailure { Log.w("AlertLayers", "Status poll tick failed: ${it.message}") }
            }
        }
    }

    fun onHostStop() {
        hostStarted = false
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
            val alreadyCurrent = stateVersion == appliedStateVersion
            // Ручное обновление применяем безусловно (пере-применение тех же
            // статусов безвредно) — кнопка «Обновить» должна реально обновлять
            applyStatusBundle(stateVersion, lookup, notifyOnChange = false, force = true)
            mapController.onToast(
                if (alreadyCurrent) "Дані вже актуальні" else "Статуси тривог оновлено"
            )
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
            fetchBundleWithRetry()
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

    private suspend fun fetchBundleWithRetry(
        maxAttempts: Int = 3,
        initialDelayMs: Long = 1_000,
    ): Pair<Long, Map<String, AlertStatusInfo>>? {
        var delayMs = initialDelayMs
        repeat(maxAttempts) { attempt ->
            runCatching { fetchBundle() }
                .onSuccess { return it }
                .onFailure {
                    Log.w("AlertLayers", "Bundle fetch attempt ${attempt + 1}/$maxAttempts failed: ${it.message}")
                    if (attempt < maxAttempts - 1) {
                        delay(delayMs)
                        delayMs = (delayMs * 2).coerceAtMost(8_000)
                    }
                }
        }
        return null
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
        // Тяжёлые чтения гоним параллельно (IO-bound), но устанавливаем слои
        // по мере готовности: oblast (180 KB) даёт первый осмысленный кадр,
        // raion/hromada догружаются следом — не ждём самый тяжёлый файл.
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

        // Фаза 1: oblast + маска + occupied + meta
        oblastRawJson = oblastDeferred.await()
        oblastJson = withContext(Dispatchers.Default) {
            injectStatuses(oblastRawJson, resolvedStatuses)
        }
        loadLayerMeta()

        val boundaryFeature = boundaryDeferred.await()
        if (boundaryFeature != null) {
            ukraineBoundaryGeometry = boundaryFeature.geometry()
            maskFeature = buildMaskFeature(ukraineBoundaryGeometry)
        }
        occupiedCollectionJson = occupiedDeferred.await()
        oblastReady = true
        installLayersIfReadyOnMain()

        // Фаза 2: raion
        raionRawJson = raionDeferred.await()
        raionJson = withContext(Dispatchers.Default) {
            injectStatuses(raionRawJson, resolvedStatuses)
        }
        raionReady = true
        installLayersIfReadyOnMain()

        // Фаза 3: hromada (1.2 MB — самый тяжёлый, чаще всего дочитывает последним)
        hromadaRawJson = hromadaDeferred.await()
        hromadaJson = withContext(Dispatchers.Default) {
            injectStatuses(hromadaRawJson, resolvedStatuses)
        }
        hromadaReady = true
        installLayersIfReadyOnMain()
    }

    /**
     * installLayersIfReady создаёт GeoJsonSource — MapLibre требует UI-поток
     * (CalledFromWorkerThreadException). loadStaticGeometry исполняется в
     * Dispatchers.IO: если стиль загрузился раньше геометрии, вызов с IO-потока
     * бросал исключение и убивал всю загрузку (hromada-слой оставался
     * неустановленным на весь холодный старт). Мы сами на Main.immediate.
     */
    private suspend fun installLayersIfReadyOnMain() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            installLayersIfReady()
        } else {
            withContext(Dispatchers.Main.immediate) { installLayersIfReady() }
        }
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
        // Дельта-гейт: в тихие периоды качаем не полный бандл (~10-20 КБ каждые
        // 30 c), а ~200-байтовый запрос версии. Ошибка/не-2xx дельты = fallback
        // на полный fetch — пропуск обновления невозможен, деградация только
        // к прежнему трафику.
        if (appliedStateVersion > 0) {
            val upToDate = withContext(Dispatchers.IO) {
                runCatching { fetchDeltaUpToDate() }.getOrNull()
            }
            if (upToDate == true) return
        }
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
        lookup: Map<String, AlertStatusInfo>,
        notifyOnChange: Boolean,
        force: Boolean = false,
    ) {
        // Принимаем только более свежие версии: старый ответ из гонки
        // poll↔manual refresh не должен откатывать карту. Принудительное
        // ручное применение (force) допускает равную версию, но не меньшую.
        if (if (force) stateVersion < appliedStateVersion else stateVersion <= appliedStateVersion) return

        val changedUids = resolveStatuses(lookup)

        // Ручное обновление «вхолостую»: версия та же и ни один статус не
        // изменился — ре-инъекция не нужна (кнопка просто получит «актуально»)
        if (force && changedUids.isEmpty() && stateVersion == appliedStateVersion) return

        // Избирательная инъекция: ре-инъекция и ре-сетап источника только тех
        // слоёв, где хоть один uid изменился. Полная ре-инъекция всех трёх
        // строк (~1.6 МБ + ре-парс/тесселяция в MapLibre) на каждое изменение
        // state_version давала скачки CPU/GC во время массовых тревог.
        val statuses = resolvedStatuses
        val needOblast =
            !initialStatusesApplied || changedUids.any { layerMeta["oblast"]?.containsKey(it) == true }
        val needRaion =
            !initialStatusesApplied || changedUids.any { layerMeta["raion"]?.containsKey(it) == true }
        val needHromada =
            !initialStatusesApplied || changedUids.any { layerMeta["hromada"]?.containsKey(it) == true }
        withContext(Dispatchers.Default) {
            if (needOblast) oblastJson = injectStatuses(oblastRawJson, statuses)
            if (needRaion) raionJson = injectStatuses(raionRawJson, statuses)
            if (needHromada) hromadaJson = injectStatuses(hromadaRawJson, statuses)
        }
        MapPerf.log("AlertLayers", "statuses injected into geojson (layers:" +
            " oblast=$needOblast raion=$needRaion hromada=$needHromada, changed=${changedUids.size})")
        pushStatusesToSources(oblast = needOblast, raion = needRaion, hromada = needHromada)
        MapPerf.log("AlertLayers", "statuses pushed to sources")

        // Версию помечаем применённой только после успешной инъекции/push,
        // иначе при исключении она навсегда останется «применённой»
        if (stateVersion > appliedStateVersion) appliedStateVersion = stateVersion

        onStatusesApplied?.invoke()

        val wasInitial = !initialStatusesApplied
        initialStatusesApplied = true
        if (wasInitial) {
            MapPerf.log("AlertLayers", "statuses applied (state_version=$stateVersion, lookup=${lookup.size})")
        }

        if (notifyOnChange && !wasInitial && changedUids.isNotEmpty()) {
            mapController.onToast("Статуси тривог оновлено")
        }
    }

    /** true — серверная state_version не новее применённой, полный fetch не нужен. */
    private fun fetchDeltaUpToDate(): Boolean {
        val url = apiBaseUrl.trimEnd('/') +
            "/alerts/statuses/delta?since_version=$appliedStateVersion"
        val json = JSONObject(Http.get(url))
        val toVersion = json.optLong("to_version", Long.MIN_VALUE)
        return toVersion != Long.MIN_VALUE && toVersion <= appliedStateVersion
    }

    private fun fetchBundle(): Pair<Long, Map<String, AlertStatusInfo>> {
        val url = apiBaseUrl.trimEnd('/') + "/map/bundle"
        val text = Http.get(url)

        val json = JSONObject(text)
        val stateVersion = json.optLong("state_version", 0)
        val lookup = mutableMapOf<String, AlertStatusInfo>()
        val lookupJson = json.optJSONObject("status_lookup")
        if (lookupJson != null) {
            val keys = lookupJson.keys()
            while (keys.hasNext()) {
                val uid = keys.next()
                val info = lookupJson.optJSONObject(uid) ?: continue
                lookup[uid] = AlertStatusInfo(
                    status = info.optString("status", " "),
                    alertType = info.optString("alert_type", "air_raid"),
                    alertLevel = info.optString("alert_level", "red"),
                )
            }
        }
        return stateVersion to lookup
    }

    // Порт applyBundleStatuses + applyKyivCityInheritedOblastStatus из
    // static-geometry.js: эффективный статус по uid = статус из бандла
    // (или ' ' если региона нет в lookup); м. Київ наследует статус Киевской
    // области, если у города нет собственной активной тривоги.
    // Возвращает uid'ы, у которых реально изменился статус/тип/уровень.
    private fun resolveStatuses(lookup: Map<String, AlertStatusInfo>): Set<String> {
        val previous = resolvedStatuses
        val resolved = HashMap<String, AlertStatusInfo>()
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

        val changed = HashSet<String>()
        resolved.forEach { (uid, info) ->
            if ((previous[uid] ?: DEFAULT_STATUS) != info) changed.add(uid)
        }
        return changed
    }

    // ── Инъекция статусов в GeoJSON-строку ───────────────────────────────────
    // Assets генерируются машинно и компактны: каждая фича содержит
    // "properties":{"uid":<число>,...} без пробелов и вложенных объектов.
    // Вставляем status/alert_type/alert_level сразу после "{" properties
    // одним проходом по строке (без полной токенизации JSON).

    private fun injectStatuses(rawJson: String, statuses: Map<String, AlertStatusInfo>): String {
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

    // ── Layer installation (прогрессивная: oblast → raion → hromada) ────────

    private fun installLayersIfReady() {
        val style = usableStyle() ?: return

        // Фаза 1: изображения, маска вне Украины, oblast-границы/заливки,
        // occupied territories, подписи областей. Первый осмысленный кадр.
        if (oblastReady && !baseLayersInstalled) {
            val t0 = SystemClock.elapsedRealtime()
            installBaseLayers(style)
            baseLayersInstalled = true
            // Слои угроз и пины подписок должны оставаться поверх базовых —
            // контроллер переустановит их при необходимости (z-order).
            mapController.onBaseLayersReinstalled(style)
            MapPerf.log("AlertLayers", "base layers installed (took " +
                "${SystemClock.elapsedRealtime() - t0} ms)")
        }

        // Фаза 2: заливки raion'ов. Встают ПОД occupied (как при монолитной
        // установке) через addLayerBelow.
        if (raionReady && !raionLayerInstalled) {
            val t0 = SystemClock.elapsedRealtime()
            if (raionJson.isNotEmpty()) {
                style.addSource(GeoJsonSource(SOURCE_RAION, raionJson))
                addAlertFillLayerBelow(style, LAYER_FILL_RAION, SOURCE_RAION,
                    statusActiveFilter(), LAYER_OCCUPIED_FILL)
            }
            raionLayerInstalled = true
            MapPerf.log("AlertLayers", "raion layer installed (took " +
                "${SystemClock.elapsedRealtime() - t0} ms)")
        }

        // Фаза 3: заливки hromada + special + иконки типов тривог
        if (hromadaReady && !hromadaLayersInstalled) {
            val t0 = SystemClock.elapsedRealtime()
            if (hromadaJson.isNotEmpty()) {
                style.addSource(GeoJsonSource(SOURCE_HROMADA, hromadaJson))
                addAlertFillLayerBelow(style, LAYER_FILL_HROMADA, SOURCE_HROMADA,
                    statusActiveFilter(), LAYER_OCCUPIED_FILL)
                addAlertFillLayerBelow(style, LAYER_FILL_SPECIAL, SOURCE_HROMADA,
                    specialActiveFilter(), LAYER_OCCUPIED_FILL)
            }
            installAlertTypeIconLayer(style)
            hromadaLayersInstalled = true
            MapPerf.log("AlertLayers", "hromada layers installed (took " +
                "${SystemClock.elapsedRealtime() - t0} ms)")
        }
    }

    private fun installBaseLayers(style: Style) {
        if (style.getImage(IMAGE_OCCUPIED_HATCH) == null) {
            style.addImage(IMAGE_OCCUPIED_HATCH, createOccupiedHatchBitmap())
        }
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

        // Границы/заливки/occupied встают ПОД подписи населённых пунктов базового
        // стиля (якорь baseLabelAnchorId) — текст остаётся ярким поверх заливок.
        // Маска вне Украины, наоборот, остаётся наверху: гасит подписи за пределами.
        addBelowBaseLabels(style, LineLayer(LAYER_OBLAST_BORDERS, SOURCE_OBLAST).withProperties(
            PropertyFactory.lineColor(COLOR_OBLAST_BORDER),
            PropertyFactory.lineWidth(1.0f),
        ))

        addAlertFillLayer(style, LAYER_FILL_OBLAST, SOURCE_OBLAST, statusActiveFilter())

        addBelowBaseLabels(style, LineLayer(LAYER_OBLAST_STATUS_BORDERS, SOURCE_OBLAST).withProperties(
            PropertyFactory.lineColor(oblastStatusBorderColor()),
            PropertyFactory.lineWidth(1.0f),
        ).apply { setFilter(Expression.eq(Expression.get("region_type"), Expression.literal("oblast"))) })

        occupiedCollectionJson?.let { json ->
            style.addSource(GeoJsonSource(SOURCE_OCCUPIED, json))
            addBelowBaseLabels(style, FillLayer(LAYER_OCCUPIED_FILL, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.fillColor(COLOR_OCCUPIED),
                PropertyFactory.fillOpacity(if (darkMode) 0.08f else 0.05f),
            ))
            addBelowBaseLabels(style, FillLayer(LAYER_OCCUPIED_HATCH, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.fillPattern(IMAGE_OCCUPIED_HATCH),
            ))
            addBelowBaseLabels(style, LineLayer(LAYER_OCCUPIED_LINE, SOURCE_OCCUPIED).withProperties(
                PropertyFactory.lineColor(COLOR_OCCUPIED),
                PropertyFactory.lineWidth(2.5f),
                PropertyFactory.lineOpacity(0.9f),
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
            ))
        }

        // Подписи областей — поверх базовых слоёв, под пинами/угрозами
        val labelFeatures = buildOblastLabelFeatures()
        if (labelFeatures.isNotEmpty()) {
            style.addSource(GeoJsonSource(SOURCE_OBLAST_LABELS,
                FeatureCollection.fromFeatures(labelFeatures)))
            style.addLayer(SymbolLayer(LAYER_OBLAST_LABELS, SOURCE_OBLAST_LABELS).withProperties(
                PropertyFactory.textField(Expression.get("city")),
                PropertyFactory.textFont(arrayOf("Noto Sans Regular")),
                PropertyFactory.textMaxWidth(8f),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_CENTER),
                PropertyFactory.textSize(
                    Expression.interpolate(Expression.linear(), Expression.zoom(),
                        Expression.literal(3), Expression.literal(8f),
                        Expression.literal(5), Expression.literal(11f),
                        Expression.literal(8), Expression.literal(13f),
                    ),
                ),
                PropertyFactory.textColor(if (darkMode) Color.WHITE else Color.parseColor("#1a1a1a")),
                PropertyFactory.textHaloWidth(0f),
                PropertyFactory.textAllowOverlap(true),
                PropertyFactory.textIgnorePlacement(true),
                PropertyFactory.visibility(Property.VISIBLE),
            ).apply { maxZoom = 7f })
            Log.d("AlertLayers", "label layer: features=${labelFeatures.size}")
        }
    }

    // Иконки спец-тривог: поверх occupied-заливок, под подписями областей
    private fun installAlertTypeIconLayer(style: Style) {
        style.addSource(GeoJsonSource(SOURCE_ALERT_ICONS, FeatureCollection.fromFeatures(buildIconFeatures())))
        val layer = SymbolLayer(LAYER_ALERT_TYPE_ICONS, SOURCE_ALERT_ICONS).withProperties(
            PropertyFactory.iconImage(Expression.get("icon")),
            PropertyFactory.iconSize(1.0f),
            PropertyFactory.iconAllowOverlap(true),
            PropertyFactory.iconIgnorePlacement(true),
        )
        if (style.getLayer(LAYER_OBLAST_LABELS) != null) {
            style.addLayerBelow(layer, LAYER_OBLAST_LABELS)
        } else {
            style.addLayer(layer)
        }
    }

    // Якорь — нижний SymbolLayer подложки с подписями населённых пунктов.
    // Заливки тревог встают ПОД него — подписи рисуются ПОВЕРХ заливок,
    // иначе полупрозрачная заливка приглушает текст (особенно заметно
    // в тёмной теме на жёлтом/красном уровне).
    // Только place_* (dark) / label_* (liberty): вода и дороги исключены —
    // water_name в dark стоит на 8-м месте стека, под него якорь нельзя
    // (заливки ушли бы под водохранилища).
    private fun resolveBaseLabelAnchor(style: Style) {
        baseLabelAnchorId = style.layers.firstOrNull { layer ->
            layer is SymbolLayer && isSettlementLabelLayer(layer)
        }?.id
    }

    private fun isSettlementLabelLayer(layer: SymbolLayer): Boolean {
        val id = layer.id
        if (!id.startsWith("place_") && !id.startsWith("label_")) return false
        return layerReadsNameField(layer)
    }

    private fun layerReadsNameField(layer: SymbolLayer): Boolean {
        val textField = layer.textField ?: return false
        return if (textField.isExpression && textField.expression != null) {
            expressionReadsNameField(textField.expression)
        } else {
            textField.value?.toString()?.let { NAME_FIELD_TEMPLATE.containsMatchIn(it) } == true
        }
    }

    // Добавить слой под якорь base-лейблов; якоря нет — наверх (старое поведение).
    private fun addBelowBaseLabels(style: Style, layer: Layer) {
        val anchor = baseLabelAnchorId
        if (anchor != null && style.getLayer(anchor) != null) {
            style.addLayerBelow(layer, anchor)
        } else {
            style.addLayer(layer)
        }
    }

    private fun addAlertFillLayer(style: Style, layerId: String, sourceId: String, filter: Expression) {
        addBelowBaseLabels(style, FillLayer(layerId, sourceId).withProperties(
            PropertyFactory.fillColor(alertFillColor()),
            PropertyFactory.fillOpacity(alertFillOpacity()),
        ).apply { setFilter(filter) })
    }

    // Заливка дочернего слоя (raion/hromada), доустанавливаемого после базовых:
    // встаёт под указанный якорь, чтобы сохранить z-order монолитной установки.
    // Якорь может отсутствовать (например, occupied не распарсился) — тогда вверх.
    private fun addAlertFillLayerBelow(
        style: Style,
        layerId: String,
        sourceId: String,
        filter: Expression,
        belowLayerId: String,
    ) {
        val layer = FillLayer(layerId, sourceId).withProperties(
            PropertyFactory.fillColor(alertFillColor()),
            PropertyFactory.fillOpacity(alertFillOpacity()),
        ).apply { setFilter(filter) }
        if (style.getLayer(belowLayerId) != null) {
            style.addLayerBelow(layer, belowLayerId)
        } else {
            style.addLayer(layer)
        }
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

    private fun pushStatusesToSources(
        oblast: Boolean = true,
        raion: Boolean = true,
        hromada: Boolean = true,
    ) {
        val style = usableStyle() ?: return
        // Источники доустанавливаются фазами — обновляем только существующие
        // (и только те слои, чьи данные реально изменились)
        if (oblast) style.getSourceAs<GeoJsonSource>(SOURCE_OBLAST)?.setGeoJson(oblastJson)
        if (raion) style.getSourceAs<GeoJsonSource>(SOURCE_RAION)?.setGeoJson(raionJson)
        if (hromada) style.getSourceAs<GeoJsonSource>(SOURCE_HROMADA)?.setGeoJson(hromadaJson)
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

    private fun buildOblastLabelFeatures(): List<Feature> {
        val oblastEntries = layerMeta["oblast"] ?: return emptyList()
        // Ручные корректировки позиций подписей (lon, lat)
        val labelOverrides: Map<String, Point> = mapOf(
            "14" to Point.fromLngLat(30.580444, 49.957971), // Київська область
        )
        val features = oblastEntries.mapNotNull { (uid, meta) ->
            val cityName = OBLAST_CITY_NAMES[uid] ?: return@mapNotNull null
            val center = labelOverrides[uid] ?: meta.center ?: return@mapNotNull null
            Feature.fromGeometry(center).apply {
                addStringProperty("city", cityName)
            }
        }
        Log.d("AlertLayers", "oblast label features: ${features.size}, " +
            "first props: ${features.firstOrNull()?.properties()}")
        return features
    }

    private fun installAlertTypeIcons(style: Style) {
        mapOf(
            "air_raid" to "map/icons/air-raid.png",
            "artillery_shelling" to "map/icons/artillery-shelling.png",
            "urban_fights" to "map/icons/urban-fights.png",
        ).forEach { (alertType, path) ->
            val name = IMAGE_ICON_PREFIX + alertType
            if (style.getImage(name) != null) return@forEach
            val bitmap = MapIconBitmapCache.get(appContext, path, 24f) ?: return@forEach
            style.addImage(name, bitmap)
        }
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
