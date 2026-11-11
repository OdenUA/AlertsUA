package com.alertsua.app.notifications

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.alertsua.app.R
import com.alertsua.app.data.AlertsRepository
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AlertFirebaseService : FirebaseMessagingService() {

    companion object {
        private const val DEDUPE_PREFS = "alert_push_dedupe"
        private const val RECENT_DISPATCH_KEYS = "recent_dispatch_keys"
        private const val MAX_RECENT_DISPATCH_KEYS = 100

        private var largeIconBitmap: Bitmap? = null
        private val dedupeLock = Any()
    }

    private fun shouldShowNotification(
        context: Context,
        dispatchId: String?,
        subscriptionId: String?,
        stateVersion: String?,
        dispatchKind: String,
    ): Boolean {
        val dedupeKey = when {
            dispatchId != null -> "dispatch:$dispatchId"
            stateVersion != null -> "state:$stateVersion:${subscriptionId.orEmpty()}:$dispatchKind"
            else -> return true
        }

        synchronized(dedupeLock) {
            val prefs = context.applicationContext.getSharedPreferences(DEDUPE_PREFS, Context.MODE_PRIVATE)
            val recentKeys = LinkedHashSet<String>()
            prefs.getString(RECENT_DISPATCH_KEYS, null)
                ?.lineSequence()
                ?.filter { it.isNotEmpty() }
                ?.forEach(recentKeys::add)

            if (!recentKeys.add(dedupeKey)) {
                return false
            }

            while (recentKeys.size > MAX_RECENT_DISPATCH_KEYS) {
                val iterator = recentKeys.iterator()
                iterator.next()
                iterator.remove()
            }
            prefs.edit()
                .putString(RECENT_DISPATCH_KEYS, recentKeys.joinToString("\n"))
                .apply()
            return true
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i("AlertsUaFirebase", "Новий FCM token (${token.length} chars)")
        val repo = AlertsRepository(applicationContext)
        repo.saveFcmToken(token)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val apiBaseUrl = repo.loadApiBaseUrl()
                repo.ensureInstallationRegistered(apiBaseUrl)
                // Update the token on server to ensure push notifications continue working
                repo.updateFcmToken(apiBaseUrl)
            } catch (e: Exception) {
                Log.w("AlertsUaFirebase", "Re-registration after token refresh failed", e)
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val settingsManager = NotificationSettingsManager(this)
        settingsManager.ensureNotificationChannel()

        val title = message.notification?.title ?: getString(R.string.push_title_start)
        val body = message.notification?.body ?: getString(R.string.push_body_start)
        val dispatchId = message.data["dispatch_id"]?.trim()?.takeIf { it.isNotEmpty() }
        val subscriptionId = message.data["subscription_id"]?.trim()?.takeIf { it.isNotEmpty() }
        val stateVersion = message.data["state_version"]?.trim()?.takeIf { it.isNotEmpty() }
        val dispatchKind = message.data["dispatch_kind"] ?: "start"
        val isStart = dispatchKind == "start"

        if (!shouldShowNotification(this, dispatchId, subscriptionId, stateVersion, dispatchKind)) {
            AlertUpdateBus.notifyUpdate()
            return
        }

        val color = if (isStart) 0xFFD32F2F.toInt() else 0xFF388E3C.toInt()
        // largeIcon декодируем один раз за процесс, а не на каждый push
        val largeIcon = largeIconBitmap
            ?: BitmapFactory.decodeResource(resources, R.drawable.ic_notification_large)?.also { largeIconBitmap = it }

        val builder = NotificationCompat.Builder(this, settingsManager.getNotificationChannelId())
            .setSmallIcon(R.drawable.ic_notification_small)
            .setLargeIcon(largeIcon)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)

        settingsManager.applyToBuilder(builder)

        val notificationManager = NotificationManagerCompat.from(this)
        val notification = builder.build()
        when {
            subscriptionId != null -> notificationManager.notify("alert_$subscriptionId", 0, notification)
            dispatchId != null -> notificationManager.notify(dispatchId, 0, notification)
            else -> notificationManager.notify(
                (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
                notification,
            )
        }

        // Будим карту: свежие статусы/угрозы подтянутся немедленно
        AlertUpdateBus.notifyUpdate()
    }
}

