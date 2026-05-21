package com.alertsua.app.ui.settings

import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.MusicOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.alertsua.app.R
import com.alertsua.app.notifications.NotificationSettingsManager
import kotlinx.coroutines.launch

@Composable
fun SoundSelectionDialog(
    currentSoundKey: String,
    onDismiss: () -> Unit,
    onSoundSelected: (String) -> Unit,
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val settingsManager = remember { NotificationSettingsManager(context) }

    var selectedSound by rememberSaveable { mutableStateOf(currentSoundKey) }
    var showCustomFilePicker by remember { mutableStateOf(false) }
    var isPlayingPreview by remember { mutableStateOf(false) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    fun stopPreview() {
        mediaPlayer?.release()
        mediaPlayer = null
        isPlayingPreview = false
    }

    fun playPreview(soundKey: String) {
        stopPreview()

        if (soundKey == NotificationSettingsManager.SOUND_SILENT) {
            Toast.makeText(context, R.string.notification_sound_silent_toast, Toast.LENGTH_SHORT).show()
            return
        }

        val soundUri = when (soundKey) {
            NotificationSettingsManager.SOUND_EMERGING_1 -> {
                Uri.parse("android.resource://${context.packageName}/${R.raw.alert_tone}")
            }
            NotificationSettingsManager.SOUND_SYSTEM -> {
                android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION)
            }
            NotificationSettingsManager.SOUND_CUSTOM -> {
                settingsManager.getActiveSoundUri()
            }
            else -> null
        }

        if (soundUri == null) {
            Toast.makeText(context, R.string.notification_sound_error, Toast.LENGTH_SHORT).show()
            return
        }

        try {
            mediaPlayer = MediaPlayer.create(context, soundUri)
            mediaPlayer?.setOnCompletionListener {
                stopPreview()
            }
            mediaPlayer?.start()
            isPlayingPreview = true
        } catch (e: Exception) {
            Toast.makeText(context, R.string.notification_sound_error, Toast.LENGTH_SHORT).show()
        }
    }

    val pickAudioFileLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            val displayName = NotificationSettingsManager.getDisplayNameFromUri(context, uri)
                ?: context.getString(R.string.notification_sound_custom)

            try {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )

                settingsManager.setCustomSound(uri, displayName)
                onSoundSelected(NotificationSettingsManager.SOUND_CUSTOM)

                Toast.makeText(context, R.string.notification_sound_saved, Toast.LENGTH_SHORT).show()
                onDismiss()
            } catch (e: Exception) {
                Toast.makeText(context, R.string.notification_sound_error, Toast.LENGTH_SHORT).show()
            }
        }
        showCustomFilePicker = false
    }

    if (showCustomFilePicker) {
        pickAudioFileLauncher.launch(arrayOf("audio/*"))
    }

    AlertDialog(
        onDismissRequest = {
            stopPreview()
            onDismiss()
        },
        title = {
            Text(text = stringResource(R.string.notification_sound_settings))
        },
        text = {
            Column(
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .selectableGroup()
            ) {
                SoundOption(
                    label = stringResource(R.string.notification_sound_emerging),
                    soundKey = NotificationSettingsManager.SOUND_EMERGING_1,
                    selectedSound = selectedSound,
                    isPlayingPreview = isPlayingPreview,
                    onClick = {
                        selectedSound = NotificationSettingsManager.SOUND_EMERGING_1
                        playPreview(NotificationSettingsManager.SOUND_EMERGING_1)
                    },
                    onPlayClick = { playPreview(NotificationSettingsManager.SOUND_EMERGING_1) },
                )

                SoundOption(
                    label = stringResource(R.string.notification_sound_system),
                    soundKey = NotificationSettingsManager.SOUND_SYSTEM,
                    selectedSound = selectedSound,
                    isPlayingPreview = isPlayingPreview,
                    onClick = {
                        selectedSound = NotificationSettingsManager.SOUND_SYSTEM
                        playPreview(NotificationSettingsManager.SOUND_SYSTEM)
                    },
                    onPlayClick = { playPreview(NotificationSettingsManager.SOUND_SYSTEM) },
                )

                SoundOption(
                    label = stringResource(R.string.notification_sound_silent),
                    soundKey = NotificationSettingsManager.SOUND_SILENT,
                    selectedSound = selectedSound,
                    isPlayingPreview = isPlayingPreview,
                    onClick = {
                        selectedSound = NotificationSettingsManager.SOUND_SILENT
                        playPreview(NotificationSettingsManager.SOUND_SILENT)
                    },
                    onPlayClick = { playPreview(NotificationSettingsManager.SOUND_SILENT) },
                )

                SoundOption(
                    label = stringResource(R.string.notification_sound_custom),
                    soundKey = NotificationSettingsManager.SOUND_CUSTOM,
                    selectedSound = selectedSound,
                    isPlayingPreview = isPlayingPreview,
                    showPlayButton = currentSoundKey == NotificationSettingsManager.SOUND_CUSTOM,
                    onClick = {
                        showCustomFilePicker = true
                    },
                    onPlayClick = { playPreview(NotificationSettingsManager.SOUND_CUSTOM) },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    coroutineScope.launch {
                        stopPreview()
                        if (selectedSound != NotificationSettingsManager.SOUND_CUSTOM) {
                            settingsManager.setSelectedSoundKey(selectedSound)
                            onSoundSelected(selectedSound)
                        }
                        onDismiss()
                    }
                }
            ) {
                Text("Зберегти")
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    stopPreview()
                    onDismiss()
                }
            ) {
                Text(stringResource(R.string.cancel))
            }
        },
    )
}

@Composable
private fun SoundOption(
    label: String,
    soundKey: String,
    selectedSound: String,
    isPlayingPreview: Boolean,
    showPlayButton: Boolean = true,
    onClick: () -> Unit,
    onPlayClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(
                selected = (soundKey == selectedSound),
                onClick = onClick,
                role = Role.RadioButton,
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = (soundKey == selectedSound),
            onClick = null,
        )

        Spacer(Modifier.width(8.dp))

        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )

        if (showPlayButton && soundKey != NotificationSettingsManager.SOUND_CUSTOM) {
            TextButton(
                onClick = onPlayClick,
                enabled = !isPlayingPreview,
            ) {
                Icon(
                    imageVector = if (soundKey == NotificationSettingsManager.SOUND_SILENT) {
                        Icons.Default.MusicOff
                    } else {
                        Icons.Default.MusicNote
                    },
                    contentDescription = stringResource(R.string.notification_sound_preview),
                    modifier = Modifier.width(18.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.notification_sound_preview))
            }
        }
    }
}
