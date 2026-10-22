package com.alertsua.app.updates

import android.app.Activity
import android.content.Context
import android.util.Log
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

/**
 * Обёртка над Google Play In-App Updates (Task API 2.x, без onActivityResult).
 *
 * Immediate — при приоритете обновления >= [HIGH_PRIORITY_THRESHOLD] или устаревании
 * текущей версии на [STALENESS_DAYS_THRESHOLD]+ дней, иначе — flexible.
 * Скачанное flexible-обновление требует перезапуска: состояние публикуется
 * через [updateDownloaded], UI показывает диалог и вызывает [completeUpdate].
 */
class AppUpdateHelper(context: Context) {

    private val appUpdateManager = AppUpdateManagerFactory.create(context)

    private val _updateDownloaded = MutableStateFlow(false)

    /** Flexible-обновление скачано — нужно предложить перезапуск. */
    val updateDownloaded: StateFlow<Boolean> = _updateDownloaded.asStateFlow()

    @Volatile
    private var checkInFlight = false

    // Одна проверка за процесс + защита от гонки onCreate/onResume
    private var checkedOnce = false

    private val installStateListener = InstallStateUpdatedListener { state ->
        if (state.installStatus() == InstallStatus.DOWNLOADED) {
            _updateDownloaded.value = true
        }
    }

    init {
        appUpdateManager.registerListener(installStateListener)
    }

    fun release() {
        appUpdateManager.unregisterListener(installStateListener)
    }

    suspend fun checkForUpdate(activity: Activity) {
        if (checkInFlight || checkedOnce) return
        checkInFlight = true
        checkedOnce = true
        try {
            val info = runCatching { appUpdateManager.appUpdateInfo.await() }
                .onFailure { Log.w(TAG, "appUpdateInfo failed", it) }
                .getOrNull() ?: return
            if (info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE) return

            val immediate = info.updatePriority() >= HIGH_PRIORITY_THRESHOLD ||
                (info.clientVersionStalenessDays() ?: 0) >= STALENESS_DAYS_THRESHOLD
            val updateType = when {
                immediate && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE) ->
                    AppUpdateType.IMMEDIATE
                info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE) -> AppUpdateType.FLEXIBLE
                else -> return
            }

            runCatching {
                val result = appUpdateManager.startUpdateFlow(
                    info,
                    activity,
                    AppUpdateOptions.newBuilder(updateType).build(),
                ).await()
                Log.i(TAG, "startUpdateFlow type=$updateType result=$result")
            }.onFailure { Log.w(TAG, "startUpdateFlow failed", it) }
        } finally {
            checkInFlight = false
        }
    }

    /** onResume: подхват прерванного immediate-флоу (канон Google) + статус скачивания. */
    suspend fun onResumed(activity: Activity) {
        val info = runCatching { appUpdateManager.appUpdateInfo.await() }.getOrNull() ?: return
        if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
            runCatching {
                appUpdateManager.startUpdateFlow(
                    info,
                    activity,
                    AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build(),
                ).await()
            }
        }
        if (info.installStatus() == InstallStatus.DOWNLOADED) {
            _updateDownloaded.value = true
        }
    }

    /** Перезапуск с только что скачанным обновлением (flexible-complete). */
    suspend fun completeUpdate() {
        runCatching { appUpdateManager.completeUpdate().await() }
        _updateDownloaded.value = false
    }

    companion object {
        private const val TAG = "AppUpdateHelper"
        private const val HIGH_PRIORITY_THRESHOLD = 4
        private const val STALENESS_DAYS_THRESHOLD = 7
    }
}
