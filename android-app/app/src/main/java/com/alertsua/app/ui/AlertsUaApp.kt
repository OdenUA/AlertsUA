package com.alertsua.app.ui

import android.app.Activity
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import com.alertsua.app.R
import com.alertsua.app.data.AlertsRepository
import com.alertsua.app.admob.AdMobBanner as AdMobComposableBanner
import com.alertsua.app.map.AlertMapScreen
import com.alertsua.app.map.simplified.SimplifiedMapScreen
import com.alertsua.app.ui.faq.FaqBottomSheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsUaApp(
    locationPermissionGranted: Boolean = false,
    requestLocationPermission: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val repository = remember(context) { AlertsRepository(context) }
    val activity = context as? Activity
    val view = LocalView.current
    var darkMode by rememberSaveable { mutableStateOf(repository.loadDarkModeEnabled()) }
    var refreshTrigger by remember { mutableIntStateOf(0) }
    var showThreats by rememberSaveable { mutableStateOf(true) }
    var isFullscreen by rememberSaveable { mutableStateOf(false) }
    var useSimplifiedMap by rememberSaveable { mutableStateOf(false) }
    var orientationChangeTrigger by remember { mutableIntStateOf(0) }
    var showFaqDialog by remember { mutableStateOf(false) }
    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    // Обновляем триггер при изменении ориентации
    LaunchedEffect(isLandscape) {
        orientationChangeTrigger++
    }

    val toggleDarkMode: () -> Unit = {
        val nextValue = !darkMode
        darkMode = nextValue
        repository.saveDarkModeEnabled(nextValue)
    }

    DisposableEffect(activity, view, isFullscreen) {
        val window = activity?.window
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, !isFullscreen)
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
                WindowCompat.setDecorFitsSystemWindows(cleanupWindow, true)
                WindowCompat.getInsetsController(cleanupWindow, view)
                    .show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    MaterialTheme(
        colorScheme = if (darkMode) darkColorScheme() else lightColorScheme(),
    ) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            bottomBar = {
                Log.d("AdMob", "isLandscape: $isLandscape, isFullscreen: $isFullscreen")
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
                                IconButton(onClick = { showThreats = !showThreats }) {
                                    Icon(
                                        painter = painterResource(
                                            id = if (showThreats) {
                                                R.drawable.ic_threat_layers_telegram_active
                                            } else {
                                                R.drawable.ic_threat_layers_telegram_inactive
                                            },
                                        ),
                                        contentDescription = stringResource(
                                            id = if (showThreats) {
                                                R.string.threat_layers_hide_telegram
                                            } else {
                                                R.string.threat_layers_show_telegram
                                            },
                                        ),
                                        tint = Color.Unspecified,
                                    )
                                }
                            }

                            IconButton(onClick = { refreshTrigger++ }) {
                                Icon(
                                    imageVector = Icons.Outlined.Refresh,
                                    contentDescription = "Manual Refresh"
                                )
                            }

                            IconButton(onClick = { useSimplifiedMap = !useSimplifiedMap }) {
                                Icon(
                                    imageVector = Icons.Outlined.Map,
                                    contentDescription = if (useSimplifiedMap) "Detailed map" else "Simplified map",
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
                    .padding(innerPadding),
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
                            showThreats = showThreats,
                            locationPermissionGranted = locationPermissionGranted,
                            requestLocationPermission = requestLocationPermission,
                        )
                    }
                }

                // AdMob Banner - поверх карты
                if (!isFullscreen) {
                    if (isLandscape) {
                        // Альбомная ориентация: слева сверху
                        AdMobComposableBanner(
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(top = 8.dp, start = 8.dp)
                                .height(50.dp),
                            isVisible = true,
                            refreshTrigger = refreshTrigger + orientationChangeTrigger,
                            isLandscape = isLandscape
                        )
                    } else {
                        // Портретная ориентация: поверх карты в отступе
                        AdMobComposableBanner(
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = 8.dp, start = 16.dp, end = 16.dp)
                                .height(50.dp),
                            isVisible = true,
                            refreshTrigger = refreshTrigger + orientationChangeTrigger,
                            isLandscape = isLandscape
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
                            IconButton(onClick = { showThreats = !showThreats }) {
                                Icon(
                                    painter = painterResource(
                                        id = if (showThreats) {
                                            R.drawable.ic_threat_layers_telegram_active
                                        } else {
                                            R.drawable.ic_threat_layers_telegram_inactive
                                        },
                                    ),
                                    contentDescription = stringResource(
                                        id = if (showThreats) {
                                            R.string.threat_layers_hide_telegram
                                        } else {
                                            R.string.threat_layers_show_telegram
                                        },
                                    ),
                                    tint = Color.Unspecified,
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
                        IconButton(onClick = { useSimplifiedMap = !useSimplifiedMap }) {
                            Icon(
                                imageVector = Icons.Outlined.Map,
                                contentDescription = if (useSimplifiedMap) "Detailed map" else "Simplified map",
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
            }

            // FAQ Dialog
            if (showFaqDialog) {
                FaqBottomSheet(onDismiss = { showFaqDialog = false })
            }
        }
    }
}
