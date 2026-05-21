package com.alertsua.app.ui.settings

import android.media.MediaPlayer
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.MusicOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.alertsua.app.R
import com.alertsua.app.notifications.NotificationSettingsManager

@Composable
fun NotificationSoundItem(
    currentSoundKey: String,
    customSoundName: String?,
    onSoundSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var isPlayingPreview by remember { mutableStateOf(false) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    fun stopPreview() {
        mediaPlayer?.release()
        mediaPlayer = null
        isPlayingPreview = false
    }

    fun playPreview() {
        stopPreview()

        if (currentSoundKey == NotificationSettingsManager.SOUND_SILENT) {
            Toast.makeText(context, R.string.notification_sound_silent_toast, Toast.LENGTH_SHORT).show()
            return
        }

        val soundUri = when (currentSoundKey) {
            NotificationSettingsManager.SOUND_EMERGING_1 -> {
                Uri.parse("android.resource://${context.packageName}/${R.raw.alert_tone}")
            }
            NotificationSettingsManager.SOUND_SYSTEM -> {
                android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION)
            }
            NotificationSettingsManager.SOUND_CUSTOM -> {
                NotificationSettingsManager(context).getActiveSoundUri()
            }
            else -> null
        }

        if (soundUri == null) {
            Toast.makeText(context, R.string.notification_sound_error, Toast.LENGTH_SHORT).show()
            return
        }

        try {
            mediaPlayer = MediaPlayer.create(context, soundUri)
            mediaPlayer?.setOnCompletionListener { stopPreview() }
            mediaPlayer?.start()
            isPlayingPreview = true
        } catch (e: Exception) {
            Toast.makeText(context, R.string.notification_sound_error, Toast.LENGTH_SHORT).show()
        }
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable { onSoundSelected(currentSoundKey) },
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            Text(
                text = stringResource(R.string.notification_sound_settings),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(8.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = getSoundLabel(currentSoundKey, customSoundName),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )

                IconButton(
                    onClick = { playPreview() },
                    enabled = !isPlayingPreview,
                ) {
                    Icon(
                        imageVector = if (currentSoundKey == NotificationSettingsManager.SOUND_SILENT) {
                            Icons.Default.MusicOff
                        } else {
                            Icons.Default.MusicNote
                        },
                        contentDescription = stringResource(R.string.notification_sound_preview),
                        tint = if (isPlayingPreview) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }
    }
}

private fun getSoundLabel(soundKey: String, customName: String?): String {
    return when (soundKey) {
        NotificationSettingsManager.SOUND_EMERGING_1 -> "Повітряна тривога"
        NotificationSettingsManager.SOUND_SYSTEM -> "Системний"
        NotificationSettingsManager.SOUND_SILENT -> "Без звуку"
        NotificationSettingsManager.SOUND_CUSTOM -> customName ?: "Власний файл"
        else -> "Невідомий"
    }
}
