package com.alertsua.app.admob

import android.content.Context
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import androidx.compose.ui.viewinterop.AndroidView

@Composable
fun AdMobBanner(
    modifier: Modifier = Modifier,
    isVisible: Boolean = true,
    refreshTrigger: Int = 0,
    isLandscape: Boolean = false
) {
    val context = LocalContext.current
    val adUnitId = remember(isLandscape) {
        // В обеих ориентациях используем стандартный баннер
        "ca-app-pub-7267693224424927/6615114075"
    }
    val adSize = remember(isLandscape) {
        // В обеих ориентациях используем стандартный размер баннера
        AdSize.BANNER
    }

    Log.d("AdMob", "AdMobBanner called with isVisible: $isVisible, refreshTrigger: $refreshTrigger, isLandscape: $isLandscape")

    // Полное пересоздание AdView при изменении параметров
    AndroidView(
        modifier = modifier,
        factory = { ctx: Context ->
            Log.d("AdMob", "Creating AdView in factory")
            AdView(ctx).apply {
                Log.d("AdMob", "Setting adUnitId: $adUnitId, adSize: $adSize")
                this.adUnitId = adUnitId
                setAdSize(adSize)
                loadAd(AdRequest.Builder().build())
                Log.d("AdMob", "AdView created and ad requested - ID: $adUnitId, Size: ${adSize.width}x${adSize.height}")
            }
        },
        update = { adView ->
            // Полное пересоздание при любом изменении
            if (refreshTrigger > 0) {
                Log.d("AdMob", "Destroying old AdView due to refreshTrigger")
                adView.destroy()
            }
        }
    )
}