package com.alertsua.app

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.alertsua.app.data.AlertsRepository
import com.alertsua.app.rateprompt.RatePromptManager
import com.alertsua.app.ui.AlertsUaApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            Log.i("AlertsUaFirebase", "POST_NOTIFICATIONS granted=$isGranted")
        }

    // Location permission state - will be observed by Composable
    var locationPermissionGranted by mutableStateOf(false)
        private set

    // Rate prompt manager
    private lateinit var ratePromptManager: RatePromptManager
    var forceShowRatePrompt by mutableStateOf(false)
        private set

    // Callback to request location permission from Composable
    var requestLocationPermissionCallback: (() -> Unit)? = null
        private set

    private val requestLocationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            Log.i("AlertMapScreen", "ACCESS_FINE_LOCATION granted=$isGranted")
            locationPermissionGranted = isGranted
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        enableEdgeToEdgeManually()

        // Initialize rate prompt manager
        ratePromptManager = RatePromptManager(applicationContext)
        ratePromptManager.recordAppOpen()
        forceShowRatePrompt = intent.getStringExtra(RatePromptManager.EXTRA_FORCE_SHOW) == "true"

        // Check if we already have location permission
        locationPermissionGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        // Set up callback for requesting location permission
        requestLocationPermissionCallback = {
            Log.i("AlertMapScreen", "Requesting ACCESS_FINE_LOCATION from MainActivity")
            requestLocationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }

        setContent {
            AlertsUaApp(
                locationPermissionGranted = locationPermissionGranted,
                requestLocationPermission = requestLocationPermissionCallback,
                forceShowRatePrompt = forceShowRatePrompt
            )
        }

        ensureNotificationsPermission()

        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                Log.i("AlertsUaFirebase", "FCM token: $token")
                val repo = AlertsRepository(applicationContext)
                repo.saveFcmToken(token)
                // Register installation with the backend and update FCM token
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val apiBaseUrl = repo.loadApiBaseUrl()
                        repo.ensureInstallationRegistered(apiBaseUrl)
                        // Always update FCM token to ensure push notifications work
                        repo.updateFcmToken(apiBaseUrl)
                    } catch (e: Exception) {
                        Log.w("AlertsUaFirebase", "Installation registration failed", e)
                    }
                }
            } else {
                Log.w("AlertsUaFirebase", "Не вдалося отримати FCM token", task.exception)
            }
        }
    }

    /**
     * Edge-to-edge без deprecated API на Android 15+ (API 35).
     *
     * androidx.activity:1.9.3 `enableEdgeToEdge()` на API 35 вызывает deprecated
     * `Window.setStatusBarColor`/`setNavigationBarColor` и ставит
     * `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES`, из-за чего Play Console
     * выдаёт предупреждение об отображении от края до края. Поэтому настройку
     * выполняем вручную: deprecated-вызовы выполняются только на старых API,
     * где они ещё поддерживаются.
     */
    private fun enableEdgeToEdgeManually() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val isDarkMode =
            (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES

        if (Build.VERSION.SDK_INT < 35) {
            // Deprecated в API 35; на Android 15+ системные панели прозрачны по умолчанию
            @Suppress("DEPRECATION")
            window.statusBarColor = Color.TRANSPARENT
            @Suppress("DEPRECATION")
            window.navigationBarColor = when {
                Build.VERSION.SDK_INT >= 29 -> Color.TRANSPARENT
                // Скрим для контраста кнопочной навигации на API 26-28 (как в enableEdgeToEdge)
                isDarkMode -> Color.argb(0x80, 0x1b, 0x1b, 0x1b)
                else -> Color.argb(0xe6, 0xff, 0xff, 0xff)
            }
        }

        if (Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = true
        }

        // Рисуем контент под вырезом камеры; SHORT_EDGES deprecated в API 35,
        // поэтому на API 30+ используем ALWAYS
        if (Build.VERSION.SDK_INT >= 30) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else if (Build.VERSION.SDK_INT >= 28) {
            @Suppress("DEPRECATION")
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !isDarkMode
            isAppearanceLightNavigationBars = !isDarkMode
        }
    }

    private fun ensureNotificationsPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }

        if (
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        forceShowRatePrompt = intent.getStringExtra(RatePromptManager.EXTRA_FORCE_SHOW) == "true"
    }
}
