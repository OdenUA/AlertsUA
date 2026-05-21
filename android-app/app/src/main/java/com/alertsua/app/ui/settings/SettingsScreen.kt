package com.alertsua.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.alertsua.app.R
import com.alertsua.app.notifications.NotificationSettingsManager

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val settingsManager = remember { NotificationSettingsManager(context) }

    var currentSoundKey by rememberSaveable {
        mutableStateOf(settingsManager.getSelectedSoundKey())
    }
    var customSoundName by rememberSaveable {
        mutableStateOf(settingsManager.getCustomSoundDisplayName())
    }
    var vibrationEnabled by rememberSaveable {
        mutableStateOf(settingsManager.isVibrationEnabled())
    }
    var showSoundDialog by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Text(text = stringResource(R.string.settings_title))
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back),
                        )
                    }
                },
            )
        },
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Сповіщення",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            NotificationSoundItem(
                currentSoundKey = currentSoundKey,
                customSoundName = customSoundName,
                onSoundSelected = {
                    showSoundDialog = true
                },
            )

            Spacer(Modifier.height(8.dp))

            VibrationSettingItem(
                vibrationEnabled = vibrationEnabled,
                onVibrationChanged = { enabled ->
                    vibrationEnabled = enabled
                    settingsManager.setVibrationEnabled(enabled)
                },
            )
        }
    }

    if (showSoundDialog) {
        SoundSelectionDialog(
            currentSoundKey = currentSoundKey,
            onDismiss = {
                showSoundDialog = false
            },
            onSoundSelected = { soundKey ->
                currentSoundKey = soundKey
                customSoundName = settingsManager.getCustomSoundDisplayName()
            },
        )
    }
}
