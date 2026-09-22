package com.alertsua.app.notifications

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * Внутрипроцессная шина: FCM-пуш → немедленное обновление слоёв карты
 * (AlertLayersManager / ThreatLayersManager), не дожидаясь тика poll.
 */
object AlertUpdateBus {
    val updates = MutableSharedFlow<Unit>(
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    fun notifyUpdate() {
        updates.tryEmit(Unit)
    }
}
