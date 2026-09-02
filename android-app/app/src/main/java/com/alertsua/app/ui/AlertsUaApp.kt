package com.alertsua.app.ui

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.Help
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.alertsua.app.R
import com.alertsua.app.data.AlertsRepository
import com.alertsua.app.admob.AdMobBanner as AdMobComposableBanner
import com.alertsua.app.map.AlertMapScreen
import com.alertsua.app.map.simplified.SimplifiedMapScreen
import com.alertsua.app.rateprompt.RatePromptManager
import com.alertsua.app.ui.faq.FaqBottomSheet
import com.alertsua.app.ui.rateprompt.RatePromptCard
import com.alertsua.app.ui.settings.SettingsScreen

// Telegram-каналы — источники угроз. Одновременно показываются угрозы только одного канала.
private const val THREAT_CHANNEL_KPSZSU = "@kpszsu"
private const val THREAT_CHANNEL_WAR_MONITOR = "@war_monitor"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsUaApp(
    locationPermissionGranted: Boolean = false,
    requestLocationPermission: (() -> Unit)? = null,
    forceShowRatePrompt: Boolean = false
) {
    val context = LocalContext.current
    val repository = remember(context) { AlertsRepository(context) }
    val activity = context as? Activity
    val view = LocalView.current
    val applicationContext = LocalContext.current.applicationContext

    // Определяем системную тему более надежным способом
    val isSystemDark = when (applicationContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) {
        Configuration.UI_MODE_NIGHT_YES -> true
        Configuration.UI_MODE_NIGHT_NO -> false
        else -> false
    }
    val configuration = LocalConfiguration.current

    // Загружаем тему один раз: при первом запуске подхватываем системную,
    // иначе используем сохранённую
    var darkMode by rememberSaveable {
        val savedTheme = repository.loadDarkModeEnabled()
        if (savedTheme == null) {
            // Первый запуск — сохраняем системную тему
            repository.saveDarkModeEnabled(isSystemDark)
            mutableStateOf(isSystemDark)
        } else {
            mutableStateOf(savedTheme)
        }
    }
    var refreshTrigger by remember { mutableIntStateOf(0) }
    var activeThreatChannel by rememberSaveable { mutableStateOf<String?>(THREAT_CHANNEL_KPSZSU) }
    var isFullscreen by rememberSaveable { mutableStateOf(false) }
    var useSimplifiedMap by rememberSaveable { mutableStateOf(repository.loadSimplifiedMapEnabled()) }
    var showFaqDialog by remember { mutableStateOf(false) }
    var showSettingsScreen by rememberSaveable { mutableStateOf(false) }
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    // Rate prompt
    val ratePromptManager = remember(context) { RatePromptManager(context) }
    var showRatePrompt by remember { mutableStateOf(false) }

    // Обновляем showRatePrompt при изменении forceShowRatePrompt
    LaunchedEffect(forceShowRatePrompt) {
        showRatePrompt = ratePromptManager.shouldShowPrompt() || forceShowRatePrompt
        Log.d("RatePromptUI", "showRatePrompt=$showRatePrompt (forceShow=$forceShowRatePrompt)")
    }

    val toggleDarkMode: () -> Unit = remember(repository) {
        {
            val nextValue = !darkMode
            darkMode = nextValue
            repository.saveDarkModeEnabled(nextValue)
        }
    }

    val toggleSimplifiedMap: () -> Unit = remember(repository) {
        {
            val nextValue = !useSimplifiedMap
            useSimplifiedMap = nextValue
            repository.saveSimplifiedMapEnabled(nextValue)
        }
    }

    DisposableEffect(activity, view, isFullscreen) {
        val window = activity?.window
        if (window != null) {
            val insetsController = WindowCompat.getInsetsController(window, view)
            if (isFullscreen) {
                insetsController.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                insetsController.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                insetsController.show(WindowInsetsCompat.Type.systemBars())
            }
        }
        onDispose {
            val cleanupWindow = activity?.window
            if (cleanupWindow != null) {
                WindowCompat.getInsetsController(cleanupWindow, view)
                    .show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    fun openPlayStore() {
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("market://details?id=com.alertsua.app")
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent.resolveActivity(context.packageManager) == null) {
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=com.alertsua.app")
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(this)
            }
        } else {
            context.startActivity(intent)
        }
    }

    val colorScheme = remember(darkMode) { if (darkMode) darkColorScheme() else lightColorScheme() }
    MaterialTheme(
        colorScheme = colorScheme,
    ) {
        if (showSettingsScreen) {
            SettingsScreen(
                onBack = { showSettingsScreen = false }
            )
        } else {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            bottomBar = {
                if (!isLandscape && !isFullscreen) {
                    androidx.compose.material3.BottomAppBar(
                        modifier = Modifier
                            .fillMaxWidth()
                            .navigationBarsPadding(),
                        containerColor = Color.Transparent,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            // All buttons centered horizontally
                            if (!useSimplifiedMap) {
                                IconButton(onClick = {
                                    activeThreatChannel = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) null else THREAT_CHANNEL_KPSZSU
                                }) {
                                    Icon(
                                        painter = painterResource(
                                            id = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) {
                                                R.drawable.ic_threat_layers_telegram_active
                                            } else {
                                                R.drawable.ic_threat_layers_telegram_inactive
                                            },
                                        ),
                                        contentDescription = stringResource(
                                            id = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) {
                                                R.string.threat_layers_hide_telegram
                                            } else {
                                                R.string.threat_layers_show_telegram
                                            },
                                        ),
                                        tint = Color.Unspecified,
                                    )
                                }
                                val warMonitorActive = activeThreatChannel == THREAT_CHANNEL_WAR_MONITOR
                                IconButton(onClick = {
                                    activeThreatChannel = if (warMonitorActive) null else THREAT_CHANNEL_WAR_MONITOR
                                }) {
                                    Image(
                                        painter = painterResource(id = R.drawable.ic_threat_layers_war_monitor),
                                        contentDescription = stringResource(
                                            id = if (warMonitorActive) {
                                                R.string.threat_layers_hide_war_monitor
                                            } else {
                                                R.string.threat_layers_show_war_monitor
                                            },
                                        ),
                                        modifier = Modifier
                                            .size(24.dp)
                                            .alpha(if (warMonitorActive) 1f else 0.45f),
                                        colorFilter = if (warMonitorActive) {
                                            null
                                        } else {
                                            ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })
                                        },
                                    )
                                }
                            }

                            IconButton(onClick = { refreshTrigger++ }) {
                                Icon(
                                    imageVector = Icons.Outlined.Refresh,
                                    contentDescription = "Manual Refresh"
                                )
                            }

                            IconButton(onClick = toggleSimplifiedMap) {
                                Icon(
                                    imageVector = Icons.Outlined.Map,
                                    contentDescription = if (useSimplifiedMap) "Стандартна карта" else "Спрощена карта",
                                )
                            }

                            IconButton(onClick = toggleDarkMode) {
                                Icon(
                                    imageVector = if (darkMode) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
                                    contentDescription = stringResource(
                                        id = if (darkMode) R.string.theme_toggle_light else R.string.theme_toggle_dark,
                                    ),
                                )
                            }

                            IconButton(onClick = { showFaqDialog = true }) {
                                Icon(
                                    imageVector = Icons.Outlined.Help,
                                    contentDescription = "Довідка / FAQ",
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }

                            IconButton(onClick = { showSettingsScreen = true }) {
                                Icon(
                                    imageVector = Icons.Outlined.Settings,
                                    contentDescription = "Налаштування",
                                )
                            }

                            IconButton(onClick = { isFullscreen = !isFullscreen }) {
                                Icon(
                                    imageVector = if (isFullscreen) {
                                        Icons.Outlined.FullscreenExit
                                    } else {
                                        Icons.Outlined.Fullscreen
                                    },
                                    contentDescription = stringResource(
                                        id = if (isFullscreen) {
                                            R.string.fullscreen_exit
                                        } else {
                                            R.string.fullscreen_enter
                                        },
                                    ),
                                )
                            }
                        }
                    }
                }
            },
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .then(
                        if (!isFullscreen) Modifier.statusBarsPadding() else Modifier
                    ),
            ) {
                // Карта с отступами, чтобы не перекрывалась рекламой
                Box(modifier = Modifier.fillMaxSize()) {
                    val modifierWithPadding = when {
                        isLandscape && !isFullscreen -> Modifier.padding(top = 8.dp, end = 56.dp) // 8px сверху под строкой состояния, 56px справа под кнопками
                        !isLandscape && !isFullscreen -> Modifier.padding(top = 50.dp) // Отступ под высоту баннера
                        else -> Modifier
                    }

                    if (useSimplifiedMap) {
                        SimplifiedMapScreen(
                            modifier = modifierWithPadding.fillMaxSize(),
                            darkMode = darkMode,
                            refreshTrigger = refreshTrigger,
                        )
                    } else {
                        AlertMapScreen(
                            modifier = modifierWithPadding.fillMaxSize(),
                            darkMode = darkMode,
                            refreshTrigger = refreshTrigger,
                            activeThreatChannel = activeThreatChannel,
                            locationPermissionGranted = locationPermissionGranted,
                            requestLocationPermission = requestLocationPermission,
                        )
                    }
                }

                // AdMob Banner - поверх карты (не зависит от обновления карты)
                if (!isFullscreen) {
                    if (isLandscape) {
                        // Альбомная ориентация: слева сверху
                        AdMobComposableBanner(
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(top = 8.dp, start = 8.dp)
                                .height(50.dp)
                        )
                    } else {
                        // Портретная ориентация: поверх карты в отступе
                        AdMobComposableBanner(
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = 8.dp, start = 16.dp, end = 16.dp)
                                .height(50.dp)
                        )
                    }
                }

                if (isLandscape && !isFullscreen) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .statusBarsPadding()
                            .padding(end = 8.dp, top = 8.dp),
                        horizontalAlignment = Alignment.End,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        // Top: Telegram threats
                        if (!useSimplifiedMap) {
                            IconButton(onClick = {
                                activeThreatChannel = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) null else THREAT_CHANNEL_KPSZSU
                            }) {
                                Icon(
                                    painter = painterResource(
                                        id = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) {
                                            R.drawable.ic_threat_layers_telegram_active
                                        } else {
                                            R.drawable.ic_threat_layers_telegram_inactive
                                        },
                                    ),
                                    contentDescription = stringResource(
                                        id = if (activeThreatChannel == THREAT_CHANNEL_KPSZSU) {
                                            R.string.threat_layers_hide_telegram
                                        } else {
                                            R.string.threat_layers_show_telegram
                                        },
                                    ),
                                    tint = Color.Unspecified,
                                )
                            }
                            val warMonitorActive = activeThreatChannel == THREAT_CHANNEL_WAR_MONITOR
                            IconButton(onClick = {
                                activeThreatChannel = if (warMonitorActive) null else THREAT_CHANNEL_WAR_MONITOR
                            }) {
                                Image(
                                    painter = painterResource(id = R.drawable.ic_threat_layers_war_monitor),
                                    contentDescription = stringResource(
                                        id = if (warMonitorActive) {
                                            R.string.threat_layers_hide_war_monitor
                                        } else {
                                            R.string.threat_layers_show_war_monitor
                                        },
                                    ),
                                    modifier = Modifier
                                        .size(24.dp)
                                        .alpha(if (warMonitorActive) 1f else 0.45f),
                                    colorFilter = if (warMonitorActive) {
                                        null
                                    } else {
                                        ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })
                                    },
                                )
                            }
                        }

                        // Middle: Refresh button
                        IconButton(onClick = { refreshTrigger++ }) {
                            Icon(
                                imageVector = Icons.Outlined.Refresh,
                                contentDescription = "Manual Refresh"
                            )
                        }

                        // Bottom: Simplified mode, Theme
                        IconButton(onClick = toggleSimplifiedMap) {
                            Icon(
                                imageVector = Icons.Outlined.Map,
                                contentDescription = if (useSimplifiedMap) "Стандартна карта" else "Спрощена карта",
                            )
                        }
                        IconButton(onClick = toggleDarkMode) {
                            Icon(
                                imageVector = if (darkMode) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
                                contentDescription = stringResource(
                                    id = if (darkMode) R.string.theme_toggle_light else R.string.theme_toggle_dark,
                                ),
                            )
                        }

                        IconButton(onClick = { showFaqDialog = true }) {
                            Icon(
                                imageVector = Icons.Outlined.Help,
                                contentDescription = "Help / FAQ",
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }

                        IconButton(onClick = { showSettingsScreen = true }) {
                            Icon(
                                imageVector = Icons.Outlined.Settings,
                                contentDescription = "Налаштування",
                            )
                        }

                        IconButton(onClick = { isFullscreen = !isFullscreen }) {
                            Icon(
                                imageVector = if (isFullscreen) {
                                    Icons.Outlined.FullscreenExit
                                } else {
                                    Icons.Outlined.Fullscreen
                                },
                                contentDescription = stringResource(
                                    id = if (isFullscreen) {
                                        R.string.fullscreen_exit
                                    } else {
                                        R.string.fullscreen_enter
                                    },
                                ),
                            )
                        }
                    }
                }

                if (isFullscreen) {
                    IconButton(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .statusBarsPadding()
                            .padding(end = 8.dp, top = 8.dp),
                        onClick = { isFullscreen = false },
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.FullscreenExit,
                            contentDescription = stringResource(R.string.fullscreen_exit),
                        )
                    }
                }

                // Rate Prompt Card - показываем внизу над bottom bar
                if (showRatePrompt && !isFullscreen) {
                    RatePromptCard(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 80.dp)
                            .navigationBarsPadding(),
                        onRate = {
                            ratePromptManager.onRated()
                            openPlayStore()
                            showRatePrompt = false
                        },
                        onLater = {
                            ratePromptManager.onLaterClicked()
                            showRatePrompt = false
                        },
                        onNever = {
                            ratePromptManager.onNeverClicked()
                            showRatePrompt = false
                        }
                    )
                }
            }
        }

            // FAQ Dialog
            if (showFaqDialog) {
                FaqBottomSheet(onDismiss = { showFaqDialog = false })
            }
    }
}
}
