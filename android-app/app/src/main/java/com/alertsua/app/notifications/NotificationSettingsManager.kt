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
        private const val CHANNEL_CLEANUP_VERSION = 3
        private const val CHANNEL_BASE_ID = "alerts_ua_channel"
        private const val LEGACY_CHANNEL_ID = "app_notification_channel"
        private const val LEGACY_CHANNEL_PREFIX = "app_notification_channel_"
        private const val VIB_ENABLED_SUFFIX = "_v1"
        private const val VIB_DISABLED_SUFFIX = "_v0"

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
        // Не обновляем канал здесь - канал будет создан с правильным ID при следующем уведомлении
        cleanUpOldChannels()
    }

    fun setCustomSound(uri: Uri, displayName: String) {
        preferences.edit()
            .putString(KEY_NOTIFICATION_SOUND, SOUND_CUSTOM)
            .putString(KEY_CUSTOM_NOTIFICATION_SOUND_URI, uri.toString())
            .putString(KEY_CUSTOM_NOTIFICATION_SOUND_NAME, displayName)
            .apply()
        cleanUpOldChannels()
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
        cleanUpOldChannels()
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Channel Methods
    // ═══════════════════════════════════════════════════════════════════════════════

    fun getNotificationChannelId(): String {
        val soundKey = getSelectedSoundKey()
        val vibrationEnabled = isVibrationEnabled()
        val vibSuffix = if (vibrationEnabled) VIB_ENABLED_SUFFIX else VIB_DISABLED_SUFFIX

        return if (soundKey == SOUND_CUSTOM) {
            val customUri = preferences.getString(KEY_CUSTOM_NOTIFICATION_SOUND_URI, null)
            if (customUri != null) {
                val hash = customUri.hashCode().toUInt().toString(16)
                "${CHANNEL_BASE_ID}_${SOUND_CUSTOM}_${hash}$vibSuffix"
            } else {
                "${CHANNEL_BASE_ID}_${SOUND_EMERGING_1}$vibSuffix"
            }
        } else {
            "${CHANNEL_BASE_ID}_${soundKey}$vibSuffix"
        }
    }

    fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channelId = getNotificationChannelId()

        // Проверяем, существует ли канал
        val existingChannel = manager.getNotificationChannel(channelId)
        if (existingChannel != null) {
            return
        }

        // Очищаем старые каналы при необходимости
        val cleanupVersion = preferences.getInt(KEY_CHANNEL_CLEANUP_VERSION, 0)
        if (cleanupVersion < CHANNEL_CLEANUP_VERSION) {
            cleanUpAllOldChannels(manager)
            preferences.edit().putInt(KEY_CHANNEL_CLEANUP_VERSION, CHANNEL_CLEANUP_VERSION).apply()
        }

        val soundKey = getSelectedSoundKey()
        val vibrationEnabled = isVibrationEnabled()

        val channel = NotificationChannel(
            channelId,
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

    private fun cleanUpOldChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val currentChannelId = getNotificationChannelId()

        val channels = manager.notificationChannels
        val channelsToDelete = channels.filter { channel ->
            channel.id != currentChannelId && (
                channel.id == LEGACY_CHANNEL_ID ||
                channel.id.startsWith(LEGACY_CHANNEL_PREFIX) ||
                (channel.id.startsWith(CHANNEL_BASE_ID) && channel.id != currentChannelId)
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

    private fun cleanUpAllOldChannels(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val currentChannelId = getNotificationChannelId()

        val channels = manager.notificationChannels
        val channelsToDelete = channels.filter { channel ->
            channel.id != currentChannelId && (
                channel.id == LEGACY_CHANNEL_ID ||
                channel.id.startsWith(LEGACY_CHANNEL_PREFIX) ||
                channel.id.startsWith(CHANNEL_BASE_ID)
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
