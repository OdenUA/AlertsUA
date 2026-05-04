package com.alertsua.app

import android.app.Application
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.google.android.gms.ads.MobileAds

class AlertApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        // Initialize AdMob asynchronously to avoid blocking the main thread
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Log.d("AdMob", "Initializing MobileAds SDK asynchronously")
                MobileAds.initialize(this@AlertApplication) {
                    Log.d("AdMob", "MobileAds SDK initialized")
                }
            } catch (e: Exception) {
                Log.e("AdMob", "Failed to initialize MobileAds SDK", e)
            }
        }
    }
}
