package com.alertsua.app.map

import android.annotation.SuppressLint
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
@Composable
fun LeafletMapView(
    modifier: Modifier = Modifier,
    bridge: LeafletBridge,
    mapController: MapController,
    apiBaseUrl: String,
    darkMode: Boolean = false,
) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                settings.allowFileAccess = true
                settings.allowContentAccess = true
                settings.allowFileAccessFromFileURLs = true
                settings.allowUniversalAccessFromFileURLs = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        view?.let {
                            val dark = (it.tag as? Pair<*, *>)?.second as? Boolean ?: false
                            setMapTheme(it, dark)
                            configureApiBaseUrl(it, ((it.tag as? Pair<*, *>)?.first as? String).orEmpty())
                            requestMapLayoutRefresh(it)
                            mapController.notifyPageReady()
                        }
                    }
                }
                webChromeClient = WebChromeClient()
                addJavascriptInterface(bridge, "AndroidBridge")
                mapController.attach(this)
                tag = Pair(apiBaseUrl, darkMode)
                loadUrl("file:///android_asset/leaflet/index.html")
            }
        },
        update = { webView ->
            webView.tag = Pair(apiBaseUrl, darkMode)
            setMapTheme(webView, darkMode)
            configureApiBaseUrl(webView, apiBaseUrl)
            requestMapLayoutRefresh(webView)
        },
    )
}

private fun configureApiBaseUrl(webView: WebView, apiBaseUrl: String) {
    val escapedApiBaseUrl = JSONObject.quote(apiBaseUrl)
    evaluateJavascriptWhenReady(
        webView = webView,
        functionName = "configureAlertsUa",
        script = "window.configureAlertsUa($escapedApiBaseUrl);",
    )
}

private fun setMapTheme(webView: WebView, darkMode: Boolean) {
    evaluateJavascriptWhenReady(
        webView = webView,
        functionName = "setMapTheme",
        script = "window.setMapTheme($darkMode);",
    )
}

private fun requestMapLayoutRefresh(webView: WebView) {
    webView.postDelayed({
        evaluateJavascriptWhenReady(
            webView = webView,
            functionName = "invalidateAlertsUaMap",
            script = "window.invalidateAlertsUaMap();",
        )
    }, 250)
}

private fun evaluateJavascriptWhenReady(
    webView: WebView,
    functionName: String,
    script: String,
    attemptsLeft: Int = 20,
) {
    val readinessCheck = "typeof window.$functionName === 'function'"
    webView.evaluateJavascript(readinessCheck) { result ->
        if (result == "true") {
            webView.evaluateJavascript(script, null)
            return@evaluateJavascript
        }

        if (attemptsLeft > 0) {
            webView.postDelayed({
                evaluateJavascriptWhenReady(
                    webView = webView,
                    functionName = functionName,
                    script = script,
                    attemptsLeft = attemptsLeft - 1,
                )
            }, 100)
        }
    }
}
