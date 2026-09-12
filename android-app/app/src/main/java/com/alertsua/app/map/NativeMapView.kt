package com.alertsua.app.map

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer

private const val STYLE_LIGHT = "https://tiles.openfreemap.org/styles/liberty"
private const val STYLE_DARK = "https://tiles.openfreemap.org/styles/dark"

/** Замеры холодного старта карты: elapsed от первой композиции NativeMapView. */
internal object MapPerf {
    private val t0 = SystemClock.elapsedRealtime()
    fun log(tag: String, message: String) {
        Log.d(tag, "[+${SystemClock.elapsedRealtime() - t0} ms] $message")
    }
}

private class NativeMapState {
    var mapView: MapView? = null
    var map: MapLibreMap? = null
    var appliedDarkMode: Boolean? = null
    var appliedTopInsetDp: Int? = null
    var pageReadyNotified = false
}

@Composable
fun NativeMapView(
    modifier: Modifier = Modifier,
    mapController: MapController,
    apiBaseUrl: String,
    darkMode: Boolean = false,
    mapTopInsetDp: Int = 0,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val state = remember { NativeMapState() }
    val layersManager = remember {
        AlertLayersManager(context.applicationContext, mapController).also {
            mapController.alertLayersManager = it
        }
    }
    val threatLayersManager = remember {
        ThreatLayersManager(context.applicationContext, mapController).also {
            mapController.threatLayersManager = it
        }
    }

    SideEffect {
        layersManager.updateConfig(apiBaseUrl, darkMode)
        threatLayersManager.updateConfig(apiBaseUrl, darkMode)
    }

    // Форвардим lifecycle в MapView; polling статусов паузим в фоне
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            val mapView = state.mapView
            when (event) {
                Lifecycle.Event.ON_START -> {
                    mapView?.onStart()
                    layersManager.onHostStart()
                    threatLayersManager.onHostStart()
                }
                Lifecycle.Event.ON_RESUME -> mapView?.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView?.onPause()
                Lifecycle.Event.ON_STOP -> {
                    mapView?.onStop()
                    layersManager.onHostStop()
                    threatLayersManager.onHostStop()
                }
                Lifecycle.Event.ON_DESTROY -> {
                    if (mapView != null && !mapView.isDestroyed) mapView.onDestroy()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)

        // Observer добавлен позже реальных событий — догоняем текущее состояние
        val current = lifecycleOwner.lifecycle.currentState
        if (current.isAtLeast(Lifecycle.State.STARTED)) {
            state.mapView?.onStart()
            layersManager.onHostStart()
            threatLayersManager.onHostStart()
        }
        if (current.isAtLeast(Lifecycle.State.RESUMED)) {
            state.mapView?.onResume()
        }

        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // MapView.onLowMemory не привязан к Lifecycle — ловим через ComponentCallbacks2
    DisposableEffect(context) {
        val callbacks = object : ComponentCallbacks2 {
            override fun onConfigurationChanged(newConfig: Configuration) = Unit
            @Deprecated("Deprecated in Java")
            override fun onTrimMemory(level: Int) = Unit
            @Deprecated("Deprecated in Java")
            override fun onLowMemory() {
                state.mapView?.onLowMemory()
            }
        }
        context.registerComponentCallbacks(callbacks)
        onDispose { context.unregisterComponentCallbacks(callbacks) }
    }

    AndroidView(
        modifier = modifier,
        factory = { viewContext ->
            MapPerf.log("NativeMap", "MapView factory")
            MapView(viewContext).apply {
                state.mapView = this
                onCreate(Bundle())
                getMapAsync { map ->
                    MapPerf.log("NativeMap", "onMapReady")
                    map.setPrefetchesTiles(true)
                    state.map = map
                    mapController.attach(map, viewContext)
                    layersManager.onMapReady(map)
                    threatLayersManager.onMapReady(map)

                    val ukraineBounds = LatLngBounds.from(52.4, 40.2, 44.3, 22.1)
                    map.moveCamera(CameraUpdateFactory.newLatLngBounds(ukraineBounds, 24))
                    map.setMinZoomPreference(3.0)
                    map.setMaxZoomPreference(11.0)
                    map.setLatLngBoundsForCameraTarget(ukraineBounds)

                    configureUiSettings(map, viewContext, mapTopInsetDp)
                    state.appliedTopInsetDp = mapTopInsetDp

                    map.setStyle(Style.Builder().fromUri(styleUri(darkMode))) { style ->
                        MapPerf.log("NativeMap", "style loaded: ${styleUri(darkMode)}")
                        state.appliedDarkMode = darkMode
                        localizeLabelsToUkrainian(style)
                        hideHeavyBaseLayers(style)
                        layersManager.onStyleLoaded(style)
                        threatLayersManager.onStyleLoaded(style)
                        mapController.onStyleLoaded(style)
                        if (!state.pageReadyNotified) {
                            state.pageReadyNotified = true
                            mapController.notifyPageReady()
                        }
                    }
                }
            }
        },
        update = { mapView ->
            state.mapView = mapView
            val map = state.map ?: return@AndroidView

            if (state.appliedDarkMode != darkMode) {
                state.appliedDarkMode = darkMode
                map.setStyle(Style.Builder().fromUri(styleUri(darkMode))) { style ->
                    MapPerf.log("NativeMap", "style reloaded: ${styleUri(darkMode)}")
                    localizeLabelsToUkrainian(style)
                    hideHeavyBaseLayers(style)
                    layersManager.onStyleLoaded(style)
                    threatLayersManager.onStyleLoaded(style)
                    mapController.onStyleLoaded(style)
                }
            }
            if (state.appliedTopInsetDp != mapTopInsetDp) {
                state.appliedTopInsetDp = mapTopInsetDp
                applyTopInset(map, mapView, mapTopInsetDp)
            }
        },
        onRelease = { mapView ->
            mapController.detach()
            mapController.alertLayersManager = null
            mapController.threatLayersManager = null
            layersManager.detach()
            threatLayersManager.detach()
            state.mapView = null
            state.map = null
            if (!mapView.isDestroyed) {
                mapView.onDestroy()
            }
        },
    )
}

private fun styleUri(darkMode: Boolean): String = if (darkMode) STYLE_DARK else STYLE_LIGHT

/**
 * Только украинские подписи на подложке: во всех SymbolLayer, чей text-field
 * построен из name-полей (name, name:latin, name:nonlatin, name_en и т.п.),
 * подменяем text-field на coalesce(name:uk, name). Дорожные ref-номера
 * (["to-string",["get","ref"]]) и прочие не-name подписи не трогаем.
 * Вызывается после КАЖДОЙ загрузки стиля (смена темы пересоздаёт слои).
 */
private val UKRAINIAN_TEXT_FIELD: Expression =
    Expression.raw("[\"coalesce\",[\"get\",\"name:uk\"],[\"get\",\"name\"]]")

// Литеральный шаблон ("{name}", "{name:latin}") — для не-expression text-field
private val NAME_FIELD_TEMPLATE = Regex("\\{name([:_][A-Za-z0-9_-]+)?\\}")

private fun isNameField(value: Any?): Boolean =
    value is String && (value == "name" || value.startsWith("name:") || value.startsWith("name_"))

// Ищем ["get", <name-поле>] в дереве expression (аргументы — Object[],
// вложенные выражения — Expression)
private fun expressionReadsNameField(node: Any?): Boolean = when (node) {
    is Expression -> expressionReadsNameField(node.toArray())
    is Array<*> -> {
        if (node.size >= 2 && node[0] == "get" && isNameField(node[1])) return true
        node.any { expressionReadsNameField(it) }
    }
    else -> false
}

/**
 * Скрываем тяжёлые слои подложки (здания, landuse, hillshade) для ускорения
 * рендеринга. В OpenMapTiles/OpenFreeMap liberty все они рисуются поверх
 * дорог, поэтому после скрытия карта остаётся читаемой: дороги, границы,
 * водоймы и подписи — на месте.
 */
private val HEAVY_LAYER_IDS = setOf(
    "building", "building-3d",
    "landuse_residential", "landuse_pitch", "landuse_track",
    "landuse_cemetery", "landuse_hospital", "landuse_school",
    "landcover_wood", "landcover_grass", "landcover_ice",
    "landcover_wetland", "landcover_sand",
    "park", "park_outline",
)

private fun hideHeavyBaseLayers(style: Style) {
    var hidden = 0
    for (layer in style.layers) {
        val id = layer.id
        if (id in HEAVY_LAYER_IDS || id.contains("hillshade", ignoreCase = true)) {
            layer.setProperties(PropertyFactory.visibility(Property.NONE))
            hidden++
        }
    }
    MapPerf.log("NativeMap", "hidden heavy base layers: $hidden")
}

private fun localizeLabelsToUkrainian(style: Style) {
    var localized = 0
    style.layers.forEach { layer ->
        if (layer !is SymbolLayer) return@forEach
        val textField = layer.textField ?: return@forEach
        val readsName = if (textField.isExpression && textField.expression != null) {
            expressionReadsNameField(textField.expression)
        } else {
            textField.value?.toString()?.let { NAME_FIELD_TEMPLATE.containsMatchIn(it) } == true
        }
        if (!readsName) return@forEach
        layer.setProperties(PropertyFactory.textField(UKRAINIAN_TEXT_FIELD))
        localized++
    }
    MapPerf.log("NativeMap", "labels localized to uk: $localized symbol layers")
}

private fun configureUiSettings(map: MapLibreMap, context: Context, topInsetDp: Int) {
    map.uiSettings.isCompassEnabled = false
    map.uiSettings.isLogoEnabled = true
    map.uiSettings.isAttributionEnabled = true
    map.uiSettings.isRotateGesturesEnabled = false
    map.uiSettings.isTiltGesturesEnabled = false
    applyTopInset(map, context, topInsetDp)
}

private fun applyTopInset(map: MapLibreMap, context: Context, topInsetDp: Int) {
    val density = context.resources.displayMetrics.density
    val topPx = (topInsetDp * density).toInt()
    val edgePx = (4 * density).toInt()
    map.uiSettings.setAttributionMargins(edgePx, topPx, edgePx, edgePx)
    map.uiSettings.setLogoMargins(edgePx, topPx, edgePx, edgePx)
}

private fun applyTopInset(map: MapLibreMap, mapView: MapView, topInsetDp: Int) {
    applyTopInset(map, mapView.context, topInsetDp)
}
