package com.alertsua.app.map

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import android.graphics.BitmapFactory
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.alertsua.app.R
import com.alertsua.app.data.AlertsRepository
import com.alertsua.app.data.OblastAlertHistory
import com.alertsua.app.data.OblastAlertHistoryItem
import com.alertsua.app.data.ResolvedPoint
import com.alertsua.app.data.ResolvedRegion
import com.alertsua.app.data.SubscriptionPin
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// ─── Subscription level ──────────────────────────────────────────────────────

private enum class SubscriptionLevel(val labelRes: Int, val apiLabel: String) {
    HROMADA(R.string.subscribe_level_hromada, "Громада"),
    RAION(R.string.subscribe_level_raion, "Район"),
    OBLAST(R.string.subscribe_level_oblast, "Область"),
}

private enum class SheetActionMode {
    SUBSCRIBE,
    UNSUBSCRIBE,
}

private data class RegionHierarchyDisplay(
    val hromadaTitleUk: String,
    val hromadaStatus: String,
    val raionTitleUk: String?,
    val raionStatus: String?,
    val oblastTitleUk: String?,
    val oblastStatus: String?,
)

// ─── Screen ──────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertMapScreen(
    modifier: Modifier = Modifier,
    darkMode: Boolean = false,
    refreshTrigger: Int = 0,
    showThreats: Boolean = true,
) {
    val context = LocalContext.current
    val repository = remember(context) { AlertsRepository(context) }
    val coroutineScope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    val activeApiBaseUrl = remember { repository.loadApiBaseUrl() }

    // ── Subscribe sheet state ────────────────────────────────────────────────
    var selectedLat by remember { mutableStateOf(0.0) }
    var selectedLon by remember { mutableStateOf(0.0) }
    var resolvedPoint by remember { mutableStateOf<ResolvedPoint?>(null) }
    var isResolvingPoint by remember { mutableStateOf(false) }
    var resolveError by remember { mutableStateOf<String?>(null) }
    var showBottomSheet by rememberSaveable { mutableStateOf(false) }
    var selectedLevel by rememberSaveable { mutableStateOf(SubscriptionLevel.HROMADA) }
    var actionMode by remember { mutableStateOf(SheetActionMode.SUBSCRIBE) }
    var activeSubscriptionId by remember { mutableStateOf<String?>(null) }
    var isActionInProgress by remember { mutableStateOf(false) }

    // ── Subscription pin list (persisted) ────────────────────────────────────
    val subscriptionPins = remember {
        mutableStateListOf<SubscriptionPin>().also { it.addAll(repository.loadSubscriptionPins()) }
    }

    // ── Map controller ───────────────────────────────────────────────────────
    val mapController = remember { MapController() }

    LaunchedEffect(refreshTrigger) {
        if (refreshTrigger > 0) {
            mapController.refreshAlerts()
        }
    }

    LaunchedEffect(showThreats) {
        mapController.setThreatsVisibility(showThreats)
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                mapController.refreshAlerts()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    // Track when the WebView map page is ready so we can place markers reactively
    var mapPageReady by remember { mutableStateOf(false) }
    mapController.onMapPageReady = { mapPageReady = true }

    // Place / replace all markers whenever the pin list or map readiness changes.
    // addSubscriptionMarker is idempotent (replaces existing marker for same id).
    LaunchedEffect(subscriptionPins.toList(), mapPageReady) {
        if (mapPageReady) {
            subscriptionPins.forEach { pin ->
                mapController.addSubscriptionMarker(pin.lat, pin.lon, pin.subscriptionId)
            }
        }
    }

    // ── Sync subscriptions from server on startup (with one retry on failure) ─
    LaunchedEffect(activeApiBaseUrl) {
        var remotePins = runCatching { repository.fetchSubscriptions(activeApiBaseUrl) }.getOrNull()
        if (remotePins == null) {
            // Retry once after a short delay to handle transient network issues
            delay(8_000L)
            remotePins = runCatching { repository.fetchSubscriptions(activeApiBaseUrl) }.getOrNull()
        }
        if (!remotePins.isNullOrEmpty()) {
            subscriptionPins.clear()
            subscriptionPins.addAll(remotePins)
            repository.saveSubscriptionPins(remotePins)
            // Marker placement is handled reactively by the LaunchedEffect above
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val bridge = remember { LeafletBridge() }

    bridge.pointSelectedHandler = { latitude, longitude ->
        selectedLat = latitude
        selectedLon = longitude
        actionMode = SheetActionMode.SUBSCRIBE
        activeSubscriptionId = null
        resolvedPoint = null
        resolveError = null
        showBottomSheet = true
        coroutineScope.launch {
            isResolvingPoint = true
            try {
                resolvedPoint = repository.resolvePoint(activeApiBaseUrl, latitude, longitude)
            } catch (error: Exception) {
                resolveError = error.message ?: context.getString(R.string.resolve_point_error_fallback)
            } finally {
                isResolvingPoint = false
            }
        }
    }

    bridge.subscriptionMarkerTappedHandler = { markerId ->
        val tappedPin = subscriptionPins.find { it.subscriptionId == markerId }
        if (tappedPin == null) {
            coroutineScope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.unsubscribe_error))
            }
        } else {
            selectedLat = tappedPin.lat
            selectedLon = tappedPin.lon
            actionMode = SheetActionMode.UNSUBSCRIBE
            activeSubscriptionId = tappedPin.subscriptionId
            selectedLevel = levelFromApiLabel(tappedPin.levelLabel) ?: selectedLevel
            resolvedPoint = null
            resolveError = null
            showBottomSheet = true

            coroutineScope.launch {
                isResolvingPoint = true
                try {
                    resolvedPoint = repository.resolvePoint(activeApiBaseUrl, tappedPin.lat, tappedPin.lon)
                } catch (error: Exception) {
                    resolveError = error.message ?: context.getString(R.string.resolve_point_error_fallback)
                } finally {
                    isResolvingPoint = false
                }
            }
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        LeafletMapView(
            modifier = Modifier.fillMaxSize(),
            bridge = bridge,
            mapController = mapController,
            apiBaseUrl = activeApiBaseUrl,
            darkMode = darkMode,
        )

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        ) { data -> Snackbar(snackbarData = data) }

        // ── Subscribe sheet ──────────────────────────────────────────────────
        if (showBottomSheet) {
            ModalBottomSheet(
                onDismissRequest = { showBottomSheet = false },
                sheetState = sheetState,
                containerColor = MaterialTheme.colorScheme.surface,
            ) {
                val isSubscribeMode = actionMode == SheetActionMode.SUBSCRIBE
                AlertBottomSheetContent(
                    resolvedPoint = resolvedPoint,
                    isResolvingPoint = isResolvingPoint,
                    resolveError = resolveError,
                    selectedLevel = selectedLevel,
                    onLevelSelected = { selectedLevel = it },
                    isLevelSelectionEnabled = isSubscribeMode,
                    actionLabelRes = if (isSubscribeMode) R.string.subscribe_confirm else R.string.unsubscribe_confirm,
                    isActionInProgress = isActionInProgress,
                    isActionDestructive = !isSubscribeMode,
                    onPrimaryAction = {
                        coroutineScope.launch {
                            isActionInProgress = true
                            try {
                                if (isSubscribeMode) {
                                    val subscriptionId = repository.subscribeToPoint(
                                        rawApiBaseUrl = activeApiBaseUrl,
                                        latitude = selectedLat,
                                        longitude = selectedLon,
                                        levelLabel = selectedLevel.apiLabel,
                                    )
                                    val pin = SubscriptionPin(
                                        subscriptionId = subscriptionId,
                                        lat = selectedLat,
                                        lon = selectedLon,
                                        levelLabel = selectedLevel.apiLabel,
                                    )
                                    subscriptionPins.add(pin)
                                    repository.saveSubscriptionPins(subscriptionPins)
                                    mapController.addSubscriptionMarker(pin.lat, pin.lon, pin.subscriptionId)
                                    snackbarHostState.showSnackbar(context.getString(R.string.subscribe_success))
                                } else {
                                    val subscriptionId = activeSubscriptionId
                                        ?: throw IllegalStateException("NO_ACTIVE_SUBSCRIPTION")
                                    val tappedPin = subscriptionPins.find { it.subscriptionId == subscriptionId }
                                    repository.deleteSubscription(activeApiBaseUrl, subscriptionId)
                                    if (tappedPin != null) {
                                        subscriptionPins.remove(tappedPin)
                                        repository.saveSubscriptionPins(subscriptionPins)
                                    }
                                    mapController.removeSubscriptionMarker(subscriptionId)
                                    snackbarHostState.showSnackbar(context.getString(R.string.unsubscribe_success))
                                }
                                showBottomSheet = false
                            } catch (e: Exception) {
                                val msg = if (isSubscribeMode) {
                                    if (e.message == "NO_INSTALLATION_TOKEN") {
                                        context.getString(R.string.subscribe_no_token)
                                    } else {
                                        context.getString(R.string.subscribe_error)
                                    }
                                } else {
                                    context.getString(R.string.unsubscribe_error)
                                }
                                snackbarHostState.showSnackbar(msg)
                            } finally {
                                isActionInProgress = false
                            }
                        }
                    },
                )
            }
        }

    }
}

// ─── Bottom sheet content ─────────────────────────────────────────────────────

@Composable
private fun AlertBottomSheetContent(
    resolvedPoint: ResolvedPoint?,
    isResolvingPoint: Boolean,
    resolveError: String?,
    selectedLevel: SubscriptionLevel,
    onLevelSelected: (SubscriptionLevel) -> Unit,
    isLevelSelectionEnabled: Boolean,
    actionLabelRes: Int,
    isActionInProgress: Boolean,
    isActionDestructive: Boolean,
    onPrimaryAction: () -> Unit,
) {
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(scrollState)
            .navigationBarsPadding()
            .padding(horizontal = 24.dp, vertical = 4.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (isResolvingPoint) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(
                    text = stringResource(R.string.resolve_point_loading),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return
        }

        if (resolveError != null) {
            Text(
                text = resolveError,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            return
        }

        if (resolvedPoint == null) {
            Text(
                text = stringResource(R.string.selected_point_pending),
                style = MaterialTheme.typography.bodyMedium,
            )
            return
        }

        val region = resolvedPoint.resolvedRegion

        // ── Region hierarchy ─────────────────────────────────────────────────
        RegionHierarchySection(region = region)

        // ── Alert duration ───────────────────────────────────────────────────
        if (region.activeFrom != null) {
            AlertDurationRow(activeFrom = region.activeFrom)
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        // ── Subscription section ─────────────────────────────────────────────
        Text(
            text = stringResource(R.string.subscribe_title),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Column(Modifier.selectableGroup()) {
            SubscriptionLevel.entries.forEach { level ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = (selectedLevel == level),
                            onClick = { onLevelSelected(level) },
                            enabled = isLevelSelectionEnabled,
                            role = Role.RadioButton,
                        )
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(
                        selected = (selectedLevel == level),
                        onClick = null,
                        enabled = isLevelSelectionEnabled,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = stringResource(level.labelRes),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isLevelSelectionEnabled) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }

        Button(
            onClick = onPrimaryAction,
            enabled = !isActionInProgress,
            modifier = Modifier.fillMaxWidth(),
            colors = if (isActionDestructive) {
                ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
            } else {
                ButtonDefaults.buttonColors()
            },
        ) {
            if (isActionInProgress) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = if (isActionDestructive) {
                        MaterialTheme.colorScheme.onError
                    } else {
                        MaterialTheme.colorScheme.onPrimary
                    },
                )
            } else {
                Text(text = stringResource(actionLabelRes))
            }
        }

        // ── Oblast history (today / yesterday) ──────────────────────────────
        if (region.oblastUid != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            OblastHistorySection(history = region.oblastHistory)
        }
    }
}

private fun levelFromApiLabel(label: String?): SubscriptionLevel? {
    return when (label) {
        SubscriptionLevel.HROMADA.apiLabel -> SubscriptionLevel.HROMADA
        SubscriptionLevel.RAION.apiLabel -> SubscriptionLevel.RAION
        SubscriptionLevel.OBLAST.apiLabel -> SubscriptionLevel.OBLAST
        else -> null
    }
}

// ─── Region hierarchy rows ────────────────────────────────────────────────────

@Composable
private fun RegionHierarchySection(region: ResolvedRegion) {
    val display = region.toHierarchyDisplay()

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RegionRow(labelRes = R.string.region_label_hromada, title = display.hromadaTitleUk, status = display.hromadaStatus)
        if (display.raionTitleUk != null && display.raionStatus != null) {
            RegionRow(labelRes = R.string.region_label_raion, title = display.raionTitleUk, status = display.raionStatus)
        }
        if (display.oblastTitleUk != null && display.oblastStatus != null) {
            RegionRow(labelRes = R.string.region_label_oblast, title = display.oblastTitleUk, status = display.oblastStatus)
        }
    }
}

private fun ResolvedRegion.toHierarchyDisplay(): RegionHierarchyDisplay {
    if (!isKyivCityRegion()) {
        return RegionHierarchyDisplay(
            hromadaTitleUk = hromadaTitleUk,
            hromadaStatus = hromadaStatus,
            raionTitleUk = raionTitleUk,
            raionStatus = raionStatus,
            oblastTitleUk = oblastTitleUk,
            oblastStatus = oblastStatus,
        )
    }

    val oblastStatusForDisplay = oblastStatus ?: hromadaStatus

    return RegionHierarchyDisplay(
        hromadaTitleUk = "м. Київ",
        hromadaStatus = oblastStatusForDisplay,
        raionTitleUk = "м. Київ",
        raionStatus = oblastStatusForDisplay,
        oblastTitleUk = oblastTitleUk ?: "Київська область",
        oblastStatus = oblastStatusForDisplay,
    )
}

private fun ResolvedRegion.isKyivCityRegion(): Boolean {
    if (leafType != "city") {
        return false
    }

    val normalizedTitle = hromadaTitleUk
        .lowercase(Locale.ROOT)
        .replace(".", "")
        .replace("м ", "")
        .trim()

    return normalizedTitle == "київ"
}

@Composable
private fun RegionRow(labelRes: Int, title: String, status: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(labelRes) + ":",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(72.dp),
        )
        Text(
            text = title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1f),
        )
        StatusChip(status = status)
    }
}

@Composable
private fun StatusChip(status: String) {
    val color = statusColor(status)
    val label = when (status) {
        "A" -> "Тривога"
        "P" -> "Частково"
        "N" -> "Немає"
        else -> "–"
    }
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        fontWeight = FontWeight.SemiBold,
    )
}

// ─── Alert duration ───────────────────────────────────────────────────────────

@Composable
private fun AlertDurationRow(activeFrom: String) {
    val formatted = remember(activeFrom) { formatAlertTiming(activeFrom) }
    Text(
        text = formatted,
        style = MaterialTheme.typography.bodySmall,
        color = Color(0xFFD7263D),
        fontWeight = FontWeight.Medium,
    )
}

private fun formatAlertTiming(isoTimestamp: String): String {
    return try {
        val instant = parseBackendInstant(isoTimestamp)
        val zone = ZoneId.of("Europe/Kyiv")
        val start = instant.atZone(zone)
        val now = Instant.now().atZone(zone)
        val startPart = formatAlertStartLabel(start, now)
        val durationPart = formatDurationCompact(start.toInstant(), null)
        "$startPart Триває вже $durationPart"
    } catch (_: Exception) {
        isoTimestamp
    }
}

@Composable
private fun OblastHistorySection(history: OblastAlertHistory) {
    if (history.active.isEmpty() && history.today.isEmpty() && history.yesterday.isEmpty()) {
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = "Історія тривог по області",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Разделяем активные на длящиеся < 24h и >= 24h
        val longLastingActive = mutableListOf<OblastAlertHistoryItem>()
        val shortActiveItems = mutableListOf<OblastAlertHistoryItem>()

        for (item in history.active) {
            if (isAlertUnder24h(item.startedAt)) {
                shortActiveItems.add(item)
            } else {
                longLastingActive.add(item)
            }
        }

        // Объединяем краткие активные с сегодняшними завершёнными
        val todayItems = shortActiveItems + history.today

        HistoryGroup(title = "Довготривалі тривоги", items = longLastingActive)
        HistoryGroup(title = "Сьогодні", items = todayItems)
        HistoryGroup(title = "Вчора", items = history.yesterday)
    }
}

private fun isAlertUnder24h(startedAt: String): Boolean {
    return try {
        val start = parseBackendInstant(startedAt)
        val duration = Duration.between(start, Instant.now())
        duration.toHours() < 24
    } catch (_: Exception) {
        true
    }
}

@Composable
private fun HistoryGroup(
    title: String,
    items: List<OblastAlertHistoryItem>,
) {
    if (items.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )

        items.forEach { item ->
            AggregatedRaionCard(item = item)
        }
    }
}

private fun alertTypeCardColor(alertType: String?, isActive: Boolean): Color = when {
    !isActive -> Color(0xFF585D64)
    alertType == "artillery_shelling" -> Color(0xFFB35800)
    alertType == "urban_fights"       -> Color(0xFF3A2D88)
    else                               -> Color(0xFF762B2D)
}

private fun alertTypeBadgeColor(alertType: String?): Color = when (alertType) {
    "artillery_shelling" -> Color(0xFF7A3A00)
    "urban_fights"       -> Color(0xFF2A1F6A)
    else                  -> Color(0xFF5A1F21)
}

@Composable
private fun AggregatedRaionCard(
    item: OblastAlertHistoryItem,
) {
    val background = alertTypeCardColor(item.alertType, isActive = item.isActive)
    val titleColor = Color(0xFFE9EDF2)

    // Формируем временную метку с использованием явного флага isActive
    val timeLabel = if (item.isActive) {
        // Активная тревога: затраченное время от начала (настоящее время)
        val timeDesc = formatHistoryPointInTime(item.startedAt)
        val duration = formatDurationCompact(item.startedAt, null)
        "$timeDesc Триває вже $duration"
    } else {
        // Завершённая тревога: начало + затраченное время (прошлое время)
        val timeDesc = formatHistoryPointInTime(item.startedAt)
        val duration = formatDurationCompact(item.startedAt, item.endedAt)
        "$timeDesc Тривала $duration"
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = background),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = item.regionTitleUk,
                style = MaterialTheme.typography.bodyMedium,
                color = titleColor,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = timeLabel,
                style = MaterialTheme.typography.bodySmall,
                color = titleColor,
                fontWeight = FontWeight.Medium,
            )
            if (item.alertType != null) {
                AlertTypeIcon(alertType = item.alertType)
            }
        }
    }
}

@Composable
private fun AlertTypeIcon(alertType: String) {
    val context = LocalContext.current
    val assetPath = when (alertType) {
        "air_raid"           -> "leaflet/icons/air-raid.png"
        "artillery_shelling" -> "leaflet/icons/artillery-shelling.png"
        "urban_fights"       -> "leaflet/icons/urban-fights.png"
        else                  -> "leaflet/icons/air-raid.png"
    }
    val label = when (alertType) {
        "air_raid"           -> "Повітряна тривога"
        "artillery_shelling" -> "Загроза артобстрілу"
        "urban_fights"       -> "Загроза вуличних боїв"
        else                  -> "Тривога"
    }
    val badgeBg = alertTypeBadgeColor(alertType)

    val bitmap = remember(assetPath) {
        runCatching {
            context.assets.open(assetPath).use { BitmapFactory.decodeStream(it) }
        }.getOrNull()
    }

    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(badgeBg)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = label,
                modifier = Modifier.size(16.dp),
                contentScale = ContentScale.Fit,
            )
        }
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = Color(0xFFE9EDF2),
        )
    }
}

private fun formatHistoryPointInTime(startedAt: String): String {
    return try {
        val zone = ZoneId.of("Europe/Kyiv")
        val start = parseBackendInstant(startedAt).atZone(zone)
        val now = Instant.now().atZone(zone)
        formatAlertStartLabel(start, now)
    } catch (_: Exception) {
        startedAt
    }
}

private fun formatDurationCompact(startedAt: String, endedAt: String?): String {
    return try {
        val startInstant = parseBackendInstant(startedAt)
        val endInstant = endedAt?.let { parseBackendInstant(it) }
        formatDurationCompact(startInstant, endInstant)
    } catch (_: Exception) {
        "—"
    }
}

private fun formatDurationCompact(startInstant: Instant, endInstant: Instant?): String {
    val finish = endInstant ?: Instant.now()
    val safeDuration = if (startInstant.isAfter(finish)) Duration.ZERO else Duration.between(startInstant, finish)
    val totalMinutes = safeDuration.toMinutes().coerceAtLeast(0L)
    val days = totalMinutes / (24 * 60)
    val hours = (totalMinutes / 60) % 24
    val minutes = totalMinutes % 60

    return buildString {
        if (days > 0) {
            append(days)
            append(dayWord(days))
            if (hours > 0 || minutes > 0) append(", ")
        }
        if (hours > 0) {
            append(hours)
            append("год")
            if (minutes > 0) append(' ')
        }
        if (minutes > 0 || (days == 0L && hours == 0L)) {
            append(minutes)
            append("хв")
        }
    }
}

private fun dayWord(days: Long): String {
    val mod10 = days % 10
    val mod100 = days % 100
    return when {
        mod10 == 1L && mod100 != 11L -> "день"
        mod10 in 2L..4L && mod100 !in 12L..14L -> "дні"
        else -> "днів"
    }
}

private fun formatAlertStartLabel(start: java.time.ZonedDateTime, now: java.time.ZonedDateTime): String {
    val locale = Locale.forLanguageTag("uk-UA")
    val timeFormatter = DateTimeFormatter.ofPattern("HH:mm", locale)
    val dateFormatter = DateTimeFormatter.ofPattern("d MMMM HH:mm", locale)

    return when {
        start.toLocalDate() == now.toLocalDate() -> "Сьогодні, ${start.format(timeFormatter)}"
        start.toLocalDate() == now.toLocalDate().minusDays(1) -> "Вчора ${start.format(timeFormatter)}"
        else -> start.format(dateFormatter)
    }
}

private fun parseBackendInstant(rawTimestamp: String): Instant {
    val normalized = rawTimestamp.trim()
        .replace(' ', 'T')
        .replace(Regex("([+-]\\d{2})$"), "$1:00")
        .replace(Regex("([+-]\\d{2})(\\d{2})$"), "$1:$2")
    return java.time.OffsetDateTime.parse(normalized).toInstant()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

@Composable
private fun statusColor(status: String): Color = when (status) {
    "A" -> Color(0xFFD7263D)
    "P" -> Color(0xFFF4A259)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
