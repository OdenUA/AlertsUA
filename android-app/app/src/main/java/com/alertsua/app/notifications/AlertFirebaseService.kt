package com.alertsua.app.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
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
        // Clear the installation token so re-registration fires with the new FCM token
        repo.saveFcmToken(token)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                repo.ensureInstallationRegistered(repo.loadApiBaseUrl())
            } catch (e: Exception) {
                Log.w("AlertsUaFirebase", "Re-registration after token refresh failed", e)
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        createChannelIfNeeded()

        val title = message.notification?.title ?: getString(R.string.push_title_start)
        val body = message.notification?.body ?: getString(R.string.push_body_start)
        val dispatchKind = message.data["dispatch_kind"] ?: "start"
        val isStart = dispatchKind == "start"

        // Red for alarm start, green for all-clear
        val color = if (isStart) 0xFFD32F2F.toInt() else 0xFF388E3C.toInt()
        val largeIcon = BitmapFactory.decodeResource(resources, R.drawable.ic_notification_large)

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setLargeIcon(largeIcon)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()

        NotificationManagerCompat.from(this).notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun createChannelIfNeeded() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.push_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        )
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "alerts_ua_air_raid"
    }
}

