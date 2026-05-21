package com.alertsua.app.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import com.alertsua.app.R

class NotificationSettingsManager(context: Context) {

    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val PREFS_NAME = "AppPrefs"
        private const val KEY_NOTIFICATION_SOUND = "notification_sound"
        private const val KEY_CUSTOM_NOTIFICATION_SOUND_URI = "custom_notification_sound_uri"
        private const val KEY_CUSTOM_NOTIFICATION_SOUND_NAME = "custom_notification_sound_name"
        private const val KEY_VIBRATION_ENABLED = "vibration_enabled"
        private const val KEY_CHANNEL_CLEANUP_VERSION = "notification_channel_cleanup_version"
        private const val CHANNEL_CLEANUP_VERSION = 2  // Увеличить при необходимости очистки
        private const val CHANNEL_ID = "alerts_ua_notifications"
        private const val LEGACY_CHANNEL_ID = "app_notification_channel"
        private const val CHANNEL_PREFIX = "app_notification_channel_"

        const val SOUND_EMERGING_1 = "emerging_1"
        const val SOUND_SYSTEM = "system"
        const val SOUND_SILENT = "silent"
        const val SOUND_CUSTOM = "custom"
        const val DEFAULT_SOUND = SOUND_EMERGING_1
        const val DEFAULT_VIBRATION_ENABLED = true

        private val VALID_SOUNDS = setOf(SOUND_EMERGING_1, SOUND_SYSTEM, SOUND_SILENT, SOUND_CUSTOM)

        fun getDisplayNameFromUri(context: Context, uri: Uri): String? {
            return try {
                val cursor = context.contentResolver.query(uri, null, null, null, null)
                cursor?.use {
                    val nameIndex = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (it.moveToFirst() && nameIndex >= 0) {
                        it.getString(nameIndex)
                    } else null
                }
            } catch (e: Exception) {
                uri.lastPathSegment
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Sound Methods
    // ═══════════════════════════════════════════════════════════════════════════════

    fun getSelectedSoundKey(): String {
        val saved = preferences.getString(KEY_NOTIFICATION_SOUND, DEFAULT_SOUND) ?: DEFAULT_SOUND
        return if (VALID_SOUNDS.contains(saved)) saved else DEFAULT_SOUND
    }

    fun setSelectedSoundKey(soundKey: String) {
        if (!VALID_SOUNDS.contains(soundKey)) return
        preferences.edit()
            .putString(KEY_NOTIFICATION_SOUND, soundKey)
            .apply()
        refreshNotificationChannel()
    }

    fun setCustomSound(uri: Uri, displayName: String) {
        preferences.edit()
            .putString(KEY_NOTIFICATION_SOUND, SOUND_CUSTOM)
            .putString(KEY_CUSTOM_NOTIFICATION_SOUND_URI, uri.toString())
            .putString(KEY_CUSTOM_NOTIFICATION_SOUND_NAME, displayName)
            .apply()
        refreshNotificationChannel()
    }

    fun getActiveSoundUri(): Uri? {
        return getSoundUri(getSelectedSoundKey())
    }

    fun isSilent(): Boolean {
        return getSelectedSoundKey() == SOUND_SILENT
    }

    fun getCustomSoundDisplayName(): String? {
        return if (getSelectedSoundKey() == SOUND_CUSTOM) {
            preferences.getString(KEY_CUSTOM_NOTIFICATION_SOUND_NAME, null)
        } else null
    }

    private fun getSoundUri(soundKey: String): Uri? {
        return when (soundKey) {
            SOUND_CUSTOM -> {
                val uriString = preferences.getString(KEY_CUSTOM_NOTIFICATION_SOUND_URI, null)
                if (uriString != null) Uri.parse(uriString) else null
            }
            SOUND_SYSTEM -> RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            SOUND_EMERGING_1 -> Uri.parse("android.resource://${appContext.packageName}/${R.raw.alert_tone}")
            SOUND_SILENT -> null
            else -> null
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Vibration Methods
    // ═══════════════════════════════════════════════════════════════════════════════

    fun isVibrationEnabled(): Boolean {
        return preferences.getBoolean(KEY_VIBRATION_ENABLED, DEFAULT_VIBRATION_ENABLED)
    }

    fun setVibrationEnabled(enabled: Boolean) {
        preferences.edit()
            .putBoolean(KEY_VIBRATION_ENABLED, enabled)
            .apply()
        refreshNotificationChannel()
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Channel Methods
    // ═══════════════════════════════════════════════════════════════════════════════

    fun getNotificationChannelId(): String {
        return CHANNEL_ID
    }

    fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val cleanupVersion = preferences.getInt(KEY_CHANNEL_CLEANUP_VERSION, 0)

        // Очищаем старые каналы при обновлении версии
        if (cleanupVersion < CHANNEL_CLEANUP_VERSION) {
            cleanUpOldChannels(manager)
            preferences.edit().putInt(KEY_CHANNEL_CLEANUP_VERSION, CHANNEL_CLEANUP_VERSION).apply()
        }

        val existingChannel = manager.getNotificationChannel(CHANNEL_ID)
        if (existingChannel != null) {
            return
        }

        val soundKey = getSelectedSoundKey()
        val vibrationEnabled = isVibrationEnabled()

        val channel = NotificationChannel(
            CHANNEL_ID,
            appContext.getString(R.string.push_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = appContext.getString(R.string.push_channel_name)
            enableLights(true)
            enableVibration(vibrationEnabled)

            val soundUri = getSoundUri(soundKey)
            if (soundUri != null) {
                setSound(soundUri, buildAudioAttributes())
            } else {
                setSound(null, null)
            }

            if (vibrationEnabled) {
                vibrationPattern = longArrayOf(0, 300, 200, 300)
            }
        }

        manager.createNotificationChannel(channel)
    }

    fun refreshNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            cleanUpOldChannels(manager)

            val soundKey = getSelectedSoundKey()
            val vibrationEnabled = isVibrationEnabled()

            val channel = NotificationChannel(
                CHANNEL_ID,
                appContext.getString(R.string.push_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = appContext.getString(R.string.push_channel_name)
                enableLights(true)
                enableVibration(vibrationEnabled)

                val soundUri = getSoundUri(soundKey)
                if (soundUri != null) {
                    setSound(soundUri, buildAudioAttributes())
                } else {
                    setSound(null, null)
                }

                if (vibrationEnabled) {
                    vibrationPattern = longArrayOf(0, 300, 200, 300)
                }
            }

            manager.createNotificationChannel(channel)
        } else {
            manager.deleteNotificationChannel(CHANNEL_ID)
            ensureNotificationChannel()
        }
    }

    fun applyToBuilder(builder: NotificationCompat.Builder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return
        }

        if (isSilent()) {
            builder.setSound(null)
        } else {
            val soundUri = getActiveSoundUri()
            if (soundUri != null) {
                builder.setSound(soundUri)
            }
        }

        if (isVibrationEnabled()) {
            builder.setVibrate(longArrayOf(0, 300, 200, 300))
        } else {
            builder.setVibrate(null)
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Private Methods
    // ═══════════════════════════════════════════════════════════════════════════════

    private fun buildAudioAttributes(): AudioAttributes {
        return AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }

    private fun cleanUpOldChannels(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channels = manager.notificationChannels
        val channelsToDelete = channels.filter { channel ->
            channel.id != CHANNEL_ID && (
                channel.id == LEGACY_CHANNEL_ID ||
                channel.id.startsWith(CHANNEL_PREFIX)
            )
        }

        channelsToDelete.forEach { channel ->
            try {
                manager.deleteNotificationChannel(channel.id)
            } catch (e: Exception) {
                // Ignore errors when deleting channels
            }
        }
    }
}
