package com.alertsua.app.map

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import org.json.JSONObject

/**
 * Состояние WebView-карты: очередь исходящих JS-команд до сигнала готовности
 * страницы (AndroidBridge.onJsReady) и последние применённые параметры,
 * чтобы update{} не слал дублирующие IPC-вызовы при каждой рекомпозиции.
 */
private class WebViewMapState {
    var webView: WebView? = null
    var jsReady: Boolean = false
    val pendingScripts = ArrayDeque<String>()
    var appliedDarkMode: Boolean? = null
    var appliedApiBaseUrl: String? = null

    fun evaluateOrQueue(script: String) {
        val wv = webView
        if (wv != null && jsReady) {
            wv.post { webView?.evaluateJavascript(script, null) }
        } else {
            pendingScripts.addLast(script)
        }
    }

    fun flushPending() {
        val wv = webView ?: return
        wv.post {
            val view = webView ?: return@post
            while (pendingScripts.isNotEmpty()) {
                view.evaluateJavascript(pendingScripts.removeFirst(), null)
            }
        }
    }
}

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
    val state = remember { WebViewMapState() }
    val lifecycleOwner = LocalLifecycleOwner.current

    // JS сигнализирует о полной готовности страницы — сбрасываем очередь команд
    DisposableEffect(bridge) {
        bridge.jsReadyListener = {
            state.webView?.post {
                state.jsReady = true
                state.flushPending()
            }
        }
        onDispose { bridge.jsReadyListener = null }
    }

    // Пауза polling и рендеринга WebView, когда приложение в фоне
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            val wv = state.webView ?: return@LifecycleEventObserver
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    wv.onPause()
                    wv.evaluateJavascript(
                        "if(window.pauseAlertsUaPolling) window.pauseAlertsUaPolling();", null,
                    )
                }
                Lifecycle.Event.ON_START -> {
                    wv.onResume()
                    wv.evaluateJavascript(
                        "if(window.resumeAlertsUaPolling) window.resumeAlertsUaPolling();", null,
                    )
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

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
                        // Страница загрузилась заново — ждём сигнала onJsReady из JS
                        state.jsReady = false
                        state.evaluateOrQueue("window.invalidateAlertsUaMap();")
                        mapController.notifyPageReady()
                        // Fallback: если страница старой версии и не пришлёт onJsReady,
                        // исполняем очередь по таймауту, чтобы не потерять команды
                        view?.postDelayed({
                            if (!state.jsReady) {
                                state.jsReady = true
                                state.flushPending()
                            }
                        }, JS_READY_FALLBACK_TIMEOUT_MS)
                    }
                }
                webChromeClient = WebChromeClient()
                addJavascriptInterface(bridge, "AndroidBridge")
                mapController.attach(this)
                mapController.jsExecutor = { script -> state.evaluateOrQueue(script) }
                state.webView = this
                loadUrl("file:///android_asset/leaflet/index.html")
            }
        },
        update = { webView ->
            state.webView = webView
            // Шлём команды в WebView только при реальном изменении параметров
            if (state.appliedApiBaseUrl != apiBaseUrl) {
                state.appliedApiBaseUrl = apiBaseUrl
                state.evaluateOrQueue("window.configureAlertsUa(${JSONObject.quote(apiBaseUrl)});")
            }
            if (state.appliedDarkMode != darkMode) {
                state.appliedDarkMode = darkMode
                state.evaluateOrQueue("window.setMapTheme($darkMode);")
            }
        },
        onRelease = { webView ->
            mapController.detach()
            state.webView = null
            state.jsReady = false
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        },
    )
}

private const val JS_READY_FALLBACK_TIMEOUT_MS = 8_000L
