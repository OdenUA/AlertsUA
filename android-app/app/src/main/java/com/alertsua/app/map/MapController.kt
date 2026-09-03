package com.alertsua.app.map

import android.webkit.WebView
import com.alertsua.app.data.SubscriptionPin
import org.json.JSONArray
import org.json.JSONObject

class MapController {
    private var webView: WebView? = null

    /**
     * Routes outgoing JS through the readiness queue of [LeafletMapView] when set,
     * so commands issued before the page signals `onJsReady` are not lost.
     */
    internal var jsExecutor: ((String) -> Unit)? = null

    /** Called when the map HTML page has finished loading and the JS is running. */
    var onMapPageReady: (() -> Unit)? = null

    internal fun attach(wv: WebView) {
        webView = wv
    }

    internal fun detach() {
        webView = null
        jsExecutor = null
    }

    internal fun notifyPageReady() {
        onMapPageReady?.invoke()
    }

    private fun evaluate(script: String) {
        val wv = webView ?: return
        wv.post {
            val executor = jsExecutor
            if (executor != null) {
                executor(script)
            } else {
                webView?.evaluateJavascript(script, null)
            }
        }
    }

    /** Places a subscription-pin marker on the map at the given coordinates. */
    fun addSubscriptionMarker(lat: Double, lon: Double, markerId: String) {
        val escapedId = JSONObject.quote(markerId)
        evaluate(
            "if (typeof window.addSubscriptionMarker === 'function') " +
                "window.addSubscriptionMarker($lat, $lon, $escapedId);"
        )
    }

    /** Restores all subscription-pin markers with a single JS call. */
    fun restoreSubscriptionMarkers(pins: List<SubscriptionPin>) {
        if (pins.isEmpty()) return
        val json = JSONArray().also { arr ->
            pins.forEach { pin ->
                arr.put(JSONObject().apply {
                    put("lat", pin.lat)
                    put("lon", pin.lon)
                    put("markerId", pin.subscriptionId)
                })
            }
        }
        evaluate(
            "if (typeof window.restoreSubscriptionMarkers === 'function') " +
                "window.restoreSubscriptionMarkers($json);"
        )
    }

    /** Removes a previously placed subscription-pin marker from the map. */
    fun removeSubscriptionMarker(markerId: String) {
        val escapedId = JSONObject.quote(markerId)
        evaluate(
            "if (typeof window.removeSubscriptionMarker === 'function') " +
                "window.removeSubscriptionMarker($escapedId);"
        )
    }

    /** Forces a refresh of the alert overlays on the map. */
    fun refreshAlerts() {
        evaluate("if(window.scheduleOverlayRefresh) window.scheduleOverlayRefresh();")
    }

    /**
     * Shows/updates the user-location marker.
     * @param center center the map on the marker (button tap) or just place it (passive display).
     */
    fun setUserLocation(lat: Double, lon: Double, center: Boolean = false) {
        evaluate(
            "if (typeof window.setUserLocation === 'function') " +
                "window.setUserLocation($lat, $lon, $center);"
        )
    }

    /** Selects which threat source channel is shown on the map (null hides all threats). */
    fun setThreatChannel(channelRef: String?) {
        val jsArg = channelRef?.let { JSONObject.quote(it) } ?: "null"
        evaluate("if(window.setThreatChannel) window.setThreatChannel($jsArg);")
    }
}
