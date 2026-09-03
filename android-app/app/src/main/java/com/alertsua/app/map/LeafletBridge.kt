package com.alertsua.app.map

import android.webkit.JavascriptInterface

class LeafletBridge {
    var pointSelectedHandler: (Double, Double) -> Unit = { _, _ -> }
    var subscriptionMarkerTappedHandler: (String) -> Unit = { _ -> }
    var locateButtonTappedHandler: () -> Unit = {}

    /** Called when the JS side signals that the map page is fully initialized. */
    internal var jsReadyListener: (() -> Unit)? = null

    @JavascriptInterface
    fun onPointSelected(latitude: Double, longitude: Double) {
        pointSelectedHandler(latitude, longitude)
    }

    @JavascriptInterface
    fun onSubscriptionMarkerTapped(markerId: String) {
        subscriptionMarkerTappedHandler(markerId)
    }

    @JavascriptInterface
    fun onJsReady() {
        jsReadyListener?.invoke()
    }

    @JavascriptInterface
    fun onLocateButtonTapped() {
        locateButtonTappedHandler()
    }
}
