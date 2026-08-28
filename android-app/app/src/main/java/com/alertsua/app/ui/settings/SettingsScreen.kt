package com.alertsua.app.ui.settings

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.alertsua.app.R
import com.alertsua.app.notifications.NotificationSettingsManager

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = context as? Activity
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

    var notificationsGranted by remember { mutableStateOf(context.hasNotificationsPermission()) }
    var locationGranted by remember {
        mutableStateOf(context.hasPermission(Manifest.permission.ACCESS_FINE_LOCATION))
    }

    // Обновляем статусы при возврате на экран (в т.ч. из системных настроек)
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        notificationsGranted = context.hasNotificationsPermission()
        locationGranted = context.hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    val notificationsPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        notificationsGranted = granted
        if (!granted && activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(
                activity, Manifest.permission.POST_NOTIFICATIONS
            )
        ) {
            // Отклонено навсегда — ведём в системные настройки приложения
            context.openAppSettings()
        }
    }

    val locationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        locationGranted = granted
        if (!granted && activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(
                activity, Manifest.permission.ACCESS_FINE_LOCATION
            )
        ) {
            context.openAppSettings()
        }
    }

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

            Text(
                text = stringResource(R.string.permissions_section_title),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            PermissionSettingItem(
                title = stringResource(R.string.permission_notifications_title),
                granted = notificationsGranted,
                onRequestClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notificationsPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )

            Spacer(Modifier.height(8.dp))

            PermissionSettingItem(
                title = stringResource(R.string.permission_location_title),
                granted = locationGranted,
                onRequestClick = {
                    locationPermissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
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

private fun Context.hasPermission(permission: String): Boolean {
    return ContextCompat.checkSelfPermission(
        this,
        permission,
    ) == PackageManager.PERMISSION_GRANTED
}

private fun Context.hasNotificationsPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        return true
    }
    return hasPermission(Manifest.permission.POST_NOTIFICATIONS)
}

private fun Context.openAppSettings() {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.fromParts("package", packageName, null)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(intent)
}
