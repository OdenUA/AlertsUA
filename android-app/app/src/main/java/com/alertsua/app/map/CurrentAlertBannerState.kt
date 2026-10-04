package com.alertsua.app.map

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Мост состояния баннера текущей громады между AlertMapScreen (там живут
 * repository / MapController / AlertLayersManager) и баннером в ui-пакете
 * (AlertsUaApp, над картой). Singleton: экран карты в приложении один.
 *
 * - hromadaTitle/leafUid/activeFrom — из POST /subscriptions/resolve-point
 *   (обновляется при старте, выдаче разрешения и ON_RESUME по таймауту/сдвигу GPS);
 * - alertStatus — из AlertLayersManager (poll /map/bundle, 30 с + FCM + ON_RESUME):
 *   null — данных ещё нет или тривоги нет; иначе AlertStatusInfo с уровнем.
 */
object CurrentAlertBannerState {
    var locationPermissionGranted by mutableStateOf(false)
    var hromadaTitle by mutableStateOf<String?>(null)
    var leafUid by mutableStateOf<Int?>(null)
    var alertStatus by mutableStateOf<AlertStatusInfo?>(null)
    var activeFrom by mutableStateOf<String?>(null)
}
