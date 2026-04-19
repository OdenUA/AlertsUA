package com.alertsua.app.map

import android.webkit.JavascriptInterface

class LeafletBridge {
    var pointSelectedHandler: (Double, Double) -> Unit = { _, _ -> }
    var subscriptionMarkerTappedHandler: (String) -> Unit = { _ -> }

    @JavascriptInterface
    fun onPointSelected(latitude: Double, longitude: Double) {
        pointSelectedHandler(latitude, longitude)
    }

    @JavascriptInterface
    fun onSubscriptionMarkerTapped(markerId: String) {
        subscriptionMarkerTappedHandler(markerId)
    }
}
