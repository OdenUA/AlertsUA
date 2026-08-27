package com.alertsua.app.admob

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import androidx.compose.ui.viewinterop.AndroidView

@Composable
fun AdMobBanner(
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current

    // Проверяем, отключена ли реклама
    if (AdManager.areAdsDisabled(context)) {
        Log.d("AdMob", "Ads are disabled via Easter egg")
        return
    }

    // AdView создаётся один раз и живёт независимо от рекомпозиций:
    // обновление карты, смена темы и т.п. на баннер не влияют
    val adView = remember {
        Log.d("AdMob", "Creating AdView")
        AdView(context).apply {
            adUnitId = "ca-app-pub-7267693224424927/6615114075"
            setAdSize(AdSize.BANNER)
            loadAd(AdRequest.Builder().build())
        }
    }

    // Уничтожаем AdView только когда баннер реально покидает композицию
    // (полноэкранный режим, закрытие экрана)
    DisposableEffect(adView) {
        onDispose {
            Log.d("AdMob", "Destroying AdView on dispose")
            adView.destroy()
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { adView }
    )
}
