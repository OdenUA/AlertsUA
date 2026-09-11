package com.alertsua.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import com.alertsua.app.data.SubscriptionPin
import com.google.gson.JsonObject
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.PropertyFactory.iconAllowOverlap
import org.maplibre.android.style.layers.PropertyFactory.iconIgnorePlacement
import org.maplibre.android.style.layers.PropertyFactory.iconImage
import org.maplibre.android.style.layers.PropertyFactory.iconSize
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Point
import kotlin.math.roundToInt

class MapController {
    var onMapPageReady: (() -> Unit)? = null
    var onPointSelected: (lat: Double, lon: Double) -> Unit = { _, _ -> }
    var onSubscriptionMarkerTapped: (String) -> Unit = {}
    var onLocateButtonTapped: () -> Unit = {}
    var onToast: (String) -> Unit = {}
    var onThreatTapped: (ThreatInfo) -> Unit = {}

    internal var alertLayersManager: AlertLayersManager? = null
    internal var threatLayersManager: ThreatLayersManager? = null

    private var map: MapLibreMap? = null
    private var style: Style? = null
    private var density: Float = 1f

    private val pins = LinkedHashMap<String, LatLng>()
    private var userLocation: LatLng? = null
    private var threatChannel: String? = null

    private val mapClickListener = MapLibreMap.OnMapClickListener { latLng -> handleMapClick(latLng) }

    internal fun attach(map: MapLibreMap, context: Context) {
        this.map = map
        this.density = context.resources.displayMetrics.density
        map.addOnMapClickListener(mapClickListener)
    }

    internal fun detach() {
        map?.removeOnMapClickListener(mapClickListener)
        map = null
        style = null
    }

    internal fun onStyleLoaded(style: Style) {
        this.style = style
        installOwnLayers(style)
    }

    /**
     * Вызывается AlertLayersManager после установки базовых слоёв (mask/fill/occupied):
     * слои угроз и пины должны оказаться поверх них (z-order), поэтому переустанавливаем.
     */
    internal fun onBaseLayersReinstalled(style: Style) {
        threatLayersManager?.reinstallLayers(style)
        installOwnLayers(style)
    }

    private fun installOwnLayers(style: Style) {
        this.style = style
        removeLayerAndSource(style, LAYER_SUBSCRIPTION_PINS, SOURCE_SUBSCRIPTION_PINS)
        removeLayerAndSource(style, LAYER_USER_LOCATION, SOURCE_USER_LOCATION)
        addImageIfMissing(style, IMAGE_SUBSCRIPTION_PIN, ::createSubscriptionPinBitmap)
        addImageIfMissing(style, IMAGE_USER_LOCATION, ::createUserLocationBitmap)
        style.addSource(GeoJsonSource(SOURCE_SUBSCRIPTION_PINS, FeatureCollection.fromFeatures(pinFeatures())))
        style.addSource(GeoJsonSource(SOURCE_USER_LOCATION, FeatureCollection.fromFeatures(locationFeatures())))
        style.addLayer(SymbolLayer(LAYER_SUBSCRIPTION_PINS, SOURCE_SUBSCRIPTION_PINS).withProperties(
            iconImage(IMAGE_SUBSCRIPTION_PIN),
            iconSize(1.0f),
            iconAllowOverlap(true),
            iconIgnorePlacement(true),
        ))
        style.addLayer(SymbolLayer(LAYER_USER_LOCATION, SOURCE_USER_LOCATION).withProperties(
            iconImage(IMAGE_USER_LOCATION),
            iconSize(1.0f),
            iconAllowOverlap(true),
            iconIgnorePlacement(true),
        ))
    }

    private fun removeLayerAndSource(style: Style, layerId: String, sourceId: String) {
        if (style.getLayer(layerId) != null) style.removeLayer(layerId)
        if (style.getSource(sourceId) != null) style.removeSource(sourceId)
    }

    private fun addImageIfMissing(style: Style, name: String, factory: () -> Bitmap) {
        if (style.getImage(name) == null) style.addImage(name, factory())
    }

    internal fun notifyPageReady() {
        onMapPageReady?.invoke()
    }

    /** Places a subscription-pin marker on the map at the given coordinates. */
    fun addSubscriptionMarker(lat: Double, lon: Double, markerId: String) {
        pins[markerId] = LatLng(lat, lon)
        pushPinSource()
    }

    /** Restores all subscription-pin markers, replacing the current set. */
    fun restoreSubscriptionMarkers(pins: List<SubscriptionPin>) {
        this.pins.clear()
        pins.forEach { pin -> this.pins[pin.subscriptionId] = LatLng(pin.lat, pin.lon) }
        pushPinSource()
    }

    /** Removes a previously placed subscription-pin marker from the map. */
    fun removeSubscriptionMarker(markerId: String) {
        pins.remove(markerId)
        pushPinSource()
    }

    /** Forces a refresh of the alert overlays on the map. */
    fun refreshAlerts() {
        alertLayersManager?.refreshStatusesNow()
    }

    /**
     * Shows/updates the user-location marker.
     * @param center center the map on the marker (button tap) or just place it (passive display).
     */
    fun setUserLocation(lat: Double, lon: Double, center: Boolean = false) {
        userLocation = LatLng(lat, lon)
        pushLocationSource()
        if (center) {
            val map = this.map ?: return
            val targetZoom = maxOf(map.cameraPosition.zoom, USER_LOCATION_MIN_ZOOM)
            map.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(lat, lon), targetZoom))
        }
    }

    /** Selects which threat source channel is shown on the map (null hides all threats). Фаза B. */
    fun setThreatChannel(channelRef: String?) {
        threatChannel = channelRef
        threatLayersManager?.setThreatChannel(channelRef)
    }

    fun zoomIn() {
        map?.animateCamera(CameraUpdateFactory.zoomIn())
    }

    fun zoomOut() {
        map?.animateCamera(CameraUpdateFactory.zoomOut())
    }

    // ── Map click handling ───────────────────────────────────────────────────

    private fun handleMapClick(latLng: LatLng): Boolean {
        val map = this.map ?: return false

        // Тап по угрозе — приоритет над пинами подписок и выбором точки
        val threat = threatLayersManager?.hitTest(latLng)
        if (threat != null) {
            onThreatTapped(threat)
            return true
        }

        // Тап по пину подписки — приоритет над выбором точки
        if (style?.getLayer(LAYER_SUBSCRIPTION_PINS) != null) {
            val screen = map.projection.toScreenLocation(latLng)
            val r = PIN_TAP_TOLERANCE_DP * density
            val rect = RectF(screen.x - r, screen.y - r, screen.x + r, screen.y + r)
            val hit = map.queryRenderedFeatures(rect, LAYER_SUBSCRIPTION_PINS)
            val markerId = hit.firstOrNull()
                ?.properties()?.get("marker_id")?.asString
            if (markerId != null) {
                onSubscriptionMarkerTapped(markerId)
                return true
            }
        }

        val boundary = alertLayersManager?.ukraineBoundaryGeometry ?: return false
        if (!pointInGeometry(latLng.longitude, latLng.latitude, boundary)) return false

        // Клик в пределах Киева резолвим в центр города, чтобы API вернул «м. Київ»
        return if (isInsideKyivCityBounds(latLng)) {
            onPointSelected(KYIV_CENTER_LAT, KYIV_CENTER_LON)
            true
        } else {
            onPointSelected(latLng.latitude, latLng.longitude)
            true
        }
    }

    private fun isInsideKyivCityBounds(latLng: LatLng): Boolean =
        latLng.latitude in KYIV_BOUNDS_SOUTH..KYIV_BOUNDS_NORTH &&
            latLng.longitude in KYIV_BOUNDS_WEST..KYIV_BOUNDS_EAST

    // ── Sources ──────────────────────────────────────────────────────────────

    private fun pinFeatures(): List<Feature> = pins.map { (markerId, position) ->
        Feature.fromGeometry(
            Point.fromLngLat(position.longitude, position.latitude),
            JsonObject().apply { addProperty("marker_id", markerId) },
        )
    }

    private fun locationFeatures(): List<Feature> {
        val location = userLocation ?: return emptyList()
        return listOf(Feature.fromGeometry(Point.fromLngLat(location.longitude, location.latitude)))
    }

    private fun pushPinSource() {
        style?.getSourceAs<GeoJsonSource>(SOURCE_SUBSCRIPTION_PINS)
            ?.setGeoJson(FeatureCollection.fromFeatures(pinFeatures()))
    }

    private fun pushLocationSource() {
        style?.getSourceAs<GeoJsonSource>(SOURCE_USER_LOCATION)
            ?.setGeoJson(FeatureCollection.fromFeatures(locationFeatures()))
    }

    // ── Marker bitmaps ───────────────────────────────────────────────────────

    private fun dp(value: Float): Float = value * density

    private fun createSubscriptionPinBitmap(): Bitmap {
        val sizePx = dp(16f).roundToInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val center = sizePx / 2f
        val white = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        val blue = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x19, 0x76, 0xd2) }
        canvas.drawCircle(center, center, sizePx / 2f, white)
        canvas.drawCircle(center, center, sizePx / 2f - dp(2f), blue)
        canvas.drawCircle(center, center, dp(3f), white)
        return bitmap
    }

    private fun createUserLocationBitmap(): Bitmap {
        val sizePx = dp(22f).roundToInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val center = sizePx / 2f
        val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(64, 0x42, 0x85, 0xf4) }
        val white = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        val blue = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x42, 0x85, 0xf4) }
        canvas.drawCircle(center, center, sizePx / 2f, halo)
        canvas.drawCircle(center, center, dp(7f), white)
        canvas.drawCircle(center, center, dp(5f), blue)
        return bitmap
    }

    companion object {
        private const val SOURCE_SUBSCRIPTION_PINS = "src-subscription-pins"
        private const val SOURCE_USER_LOCATION = "src-user-location"
        private const val LAYER_SUBSCRIPTION_PINS = "subscription-pins"
        private const val LAYER_USER_LOCATION = "user-location"
        private const val IMAGE_SUBSCRIPTION_PIN = "subscription-pin-icon"
        private const val IMAGE_USER_LOCATION = "user-location-icon"

        private const val PIN_TAP_TOLERANCE_DP = 20f
        private const val USER_LOCATION_MIN_ZOOM = 8.0

        // Точные bounds м. Киева (из /map/features?layer=oblast)
        private const val KYIV_BOUNDS_WEST = 30.23
        private const val KYIV_BOUNDS_SOUTH = 50.21
        private const val KYIV_BOUNDS_EAST = 30.83
        private const val KYIV_BOUNDS_NORTH = 50.59
        private const val KYIV_CENTER_LAT = 50.45
        private const val KYIV_CENTER_LON = 30.523
    }
}
