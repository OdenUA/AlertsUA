package com.alertsua.app.ui

import android.app.Activity
import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.alertsua.app.R
import com.alertsua.app.data.AlertsRepository
import com.alertsua.app.map.AlertMapScreen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsUaApp() {
    val context = LocalContext.current
    val repository = remember(context) { AlertsRepository(context) }
    val activity = context as? Activity
    val view = LocalView.current
    val isLandscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

    var darkMode by rememberSaveable { mutableStateOf(repository.loadDarkModeEnabled()) }
    var refreshTrigger by remember { mutableIntStateOf(0) }
    var showThreats by rememberSaveable { mutableStateOf(true) }
    var isFullscreen by rememberSaveable { mutableStateOf(false) }
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
            topBar = {
                if (!isLandscape && !isFullscreen) {
                    TopAppBar(
                        modifier = Modifier.fillMaxWidth(),
                        title = {},
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = Color.Transparent,
                        ),
                        actions = {
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
                            IconButton(onClick = { refreshTrigger++ }) {
                                Icon(
                                    imageVector = Icons.Outlined.Refresh,
                                    contentDescription = "Manual Refresh"
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
                        },
                    )
                }
            },
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
            ) {
                AlertMapScreen(
                    modifier = Modifier.fillMaxSize(),
                    darkMode = darkMode,
                    refreshTrigger = refreshTrigger,
                    showThreats = showThreats,
                )

                if (isLandscape && !isFullscreen) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .statusBarsPadding()
                            .padding(end = 8.dp, top = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
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
                        IconButton(onClick = { refreshTrigger++ }) {
                            Icon(
                                imageVector = Icons.Outlined.Refresh,
                                contentDescription = "Manual Refresh"
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
        }
    }
}
