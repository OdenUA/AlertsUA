package com.alertsua.app.map

import android.webkit.WebView
import org.json.JSONObject

class MapController {
    private var webView: WebView? = null

    /** Called when the map HTML page has finished loading and the JS is running. */
    var onMapPageReady: (() -> Unit)? = null

    internal fun attach(wv: WebView) {
        webView = wv
    }

    internal fun notifyPageReady() {
        onMapPageReady?.invoke()
    }

    /** Places a subscription-pin marker on the map at the given coordinates. */
    fun addSubscriptionMarker(lat: Double, lon: Double, markerId: String) {
        val escapedId = JSONObject.quote(markerId)
        webView?.post {
            webView?.evaluateJavascript(
                "window.addSubscriptionMarker($lat, $lon, $escapedId);", null
            )
        }
    }

    /** Removes a previously placed subscription-pin marker from the map. */
    fun removeSubscriptionMarker(markerId: String) {
        val escapedId = JSONObject.quote(markerId)
        webView?.post {
            webView?.evaluateJavascript(
                "window.removeSubscriptionMarker($escapedId);", null
            )
        }
    }

    /** Forces a refresh of the alert overlays on the map. */
    fun refreshAlerts() {
        webView?.post {
            webView?.evaluateJavascript("if(window.scheduleOverlayRefresh) window.scheduleOverlayRefresh();", null)
        }
    }

    /** Selects which threat source channel is shown on the map (null hides all threats). */
    fun setThreatChannel(channelRef: String?) {
        val jsArg = channelRef?.let { JSONObject.quote(it) } ?: "null"
        webView?.post {
            webView?.evaluateJavascript("if(window.setThreatChannel) window.setThreatChannel($jsArg);", null)
        }
    }
}
