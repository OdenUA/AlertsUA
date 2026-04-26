package com.alertsua.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import com.alertsua.app.data.AlertsRepository
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
                requestLocationPermission = requestLocationPermissionCallback
            )
        }

        ensureNotificationsPermission()

        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                Log.i("AlertsUaFirebase", "FCM token: $token")
                val repo = AlertsRepository(applicationContext)
                repo.saveFcmToken(token)
                // Register installation with the backend (no-op if already done)
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        repo.ensureInstallationRegistered(repo.loadApiBaseUrl())
                    } catch (e: Exception) {
                        Log.w("AlertsUaFirebase", "Installation registration failed", e)
                    }
                }
            } else {
                Log.w("AlertsUaFirebase", "Не вдалося отримати FCM token", task.exception)
            }
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
}
