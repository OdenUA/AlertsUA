package com.alertsua.app.notifications

import android.content.Context
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

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i("AlertsUaFirebase", "Новий FCM token: $token")
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
        val dispatchKind = message.data["dispatch_kind"] ?: "start"
        val isStart = dispatchKind == "start"

        val color = if (isStart) 0xFFD32F2F.toInt() else 0xFF388E3C.toInt()
        val largeIcon = BitmapFactory.decodeResource(resources, R.drawable.ic_notification_large)

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

        NotificationManagerCompat.from(this)
            .notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), builder.build())
    }
}

