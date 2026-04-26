package com.alertsua.app.map.simplified

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import com.alertsua.app.map.simplified.ZoomControlButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.core.content.ContextCompat
import com.alertsua.app.R
import com.alertsua.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private enum class SubscriptionLevel(val labelRes: Int, val apiLabel: String) {
    HROMADA(R.string.subscribe_level_hromada, "Громада"),
    RAION(R.string.subscribe_level_raion, "Район"),
    OBLAST(R.string.subscribe_level_oblast, "Область"),
}

private enum class SheetActionMode { SUBSCRIBE, UNSUBSCRIBE }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimplifiedMapScreen(
    modifier: Modifier = Modifier,
    darkMode: Boolean = false,
    refreshTrigger: Int = 0,
) {
    val context = LocalContext.current
    val repository = remember(context) { AlertsRepository(context) }
    val controller = remember { SimplifiedMapController() }
    val renderer = remember { SimplifiedMapRenderer() }
    val coroutineScope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    val activeApiBaseUrl = remember { repository.loadApiBaseUrl() }

    val oblasts by controller.oblasts.collectAsState()
    val activeAlerts by controller.activeAlerts.collectAsState()
    val selectedOblast by controller.selectedOblast.collectAsState()
    val tapTrigger by controller.tapTrigger.collectAsState()
    val renderVersion by controller.renderVersion.collectAsState()

    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Bottom sheet state
    var resolvedPoint by remember { mutableStateOf<ResolvedPoint?>(null) }
    var isResolvingPoint by remember { mutableStateOf(false) }
    var resolveError by remember { mutableStateOf<String?>(null) }
    var showBottomSheet by rememberSaveable { mutableStateOf(false) }
    var selectedLevel by rememberSaveable { mutableStateOf(SubscriptionLevel.HROMADA) }
    var actionMode by remember { mutableStateOf(SheetActionMode.SUBSCRIBE) }
    var activeSubscriptionId by remember { mutableStateOf<String?>(null) }
    var isActionInProgress by remember { mutableStateOf(false) }
    var retrySubscribeAfterPermissionGrant by remember { mutableStateOf(false) }
    var selectedLat by remember { mutableStateOf(0.0) }
    var selectedLon by remember { mutableStateOf(0.0) }

    val subscriptionPins = remember {
        mutableStateListOf<SubscriptionPin>().also { it.addAll(repository.loadSubscriptionPins()) }
    }

    var isRefreshing by remember { mutableStateOf(false) }

    // Refresh function
    suspend fun refreshData() {
        isRefreshing = true
        android.widget.Toast.makeText(context, "Оновлення...", android.widget.Toast.LENGTH_SHORT).show()
        try {
            val apiBaseUrl = repository.loadApiBaseUrl()
            // Load active alerts (oblasts geometry doesn't change)
            val alerts = repository.fetchActiveAlertGeometries(apiBaseUrl)
            controller.updateActiveAlerts(alerts)
        } catch (e: Exception) {
            android.util.Log.e("SimplifiedMap", "Refresh failed: ${e.message}", e)
            android.widget.Toast.makeText(context, "Помилка оновлення", android.widget.Toast.LENGTH_SHORT).show()
        } finally {
            isRefreshing = false
        }
    }

    // Load both oblasts and active alerts together on init
    LaunchedEffect(Unit) {
        isLoading = true
        errorMessage = null
        try {
            val apiBaseUrl = repository.loadApiBaseUrl()
            // Load oblasts first
            val loadedOblasts = repository.fetchSimplifiedOblastMap(apiBaseUrl)
            controller.updateOblasts(loadedOblasts)
            // Then load active alerts
            val alerts = repository.fetchActiveAlertGeometries(apiBaseUrl)
            controller.updateActiveAlerts(alerts)
        } catch (e: Exception) {
            errorMessage = e.message ?: "Failed to load map data"
        } finally {
            isLoading = false
        }
    }

    // Auto-refresh every 30 seconds
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30000L)
            refreshData()
        }
    }

    // Manual refresh via button
    LaunchedEffect(refreshTrigger) {
        if (refreshTrigger > 0) {
            refreshData()
        }
    }

    // Handle oblast selection → open bottom sheet
    LaunchedEffect(tapTrigger) {
        android.util.Log.d("SimplifiedMap", "LaunchedEffect triggered: tapTrigger=$tapTrigger, oblast=${selectedOblast?.titleUk ?: "null"}")
        selectedOblast?.let { oblast ->
            android.util.Log.d("SimplifiedMap", "Opening bottom sheet for: ${oblast.titleUk}")
            selectedLat = oblast.center.lat
            selectedLon = oblast.center.lon
            actionMode = SheetActionMode.SUBSCRIBE
            activeSubscriptionId = null
            resolvedPoint = null
            resolveError = null
            showBottomSheet = true

            coroutineScope.launch {
                isResolvingPoint = true
                try {
                    android.util.Log.d("SimplifiedMap", "Resolving point: ${oblast.center.lat}, ${oblast.center.lon}")
                    resolvedPoint = repository.resolvePoint(activeApiBaseUrl, oblast.center.lat, oblast.center.lon)
                    android.util.Log.d("SimplifiedMap", "Resolved: ${resolvedPoint?.resolvedRegion?.hromadaTitleUk}")
                } catch (error: Exception) {
                    android.util.Log.e("SimplifiedMap", "Error resolving point: ${error.message}", error)
                    resolveError = error.message ?: context.getString(R.string.resolve_point_error_fallback)
                } finally {
                    isResolvingPoint = false
                }
            }
        }
    }

    suspend fun runSubscribeAction() {
        isActionInProgress = true
        try {
            repository.ensureInstallationRegistered(activeApiBaseUrl)
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
            snackbarHostState.showSnackbar(context.getString(R.string.subscribe_success))
            showBottomSheet = false
        } catch (e: Exception) {
            val msg = if (e.message == "NO_INSTALLATION_TOKEN") {
                context.getString(R.string.subscribe_no_token)
            } else {
                context.getString(R.string.subscribe_error)
            }
            snackbarHostState.showSnackbar(msg)
        } finally {
            isActionInProgress = false
        }
    }

    suspend fun runUnsubscribeAction() {
        isActionInProgress = true
        try {
            val subscriptionId = activeSubscriptionId
                ?: throw IllegalStateException("NO_ACTIVE_SUBSCRIPTION")
            val tappedPin = subscriptionPins.find { it.subscriptionId == subscriptionId }
            repository.deleteSubscription(activeApiBaseUrl, subscriptionId)
            if (tappedPin != null) {
                subscriptionPins.remove(tappedPin)
                repository.saveSubscriptionPins(subscriptionPins)
            }
            snackbarHostState.showSnackbar(context.getString(R.string.unsubscribe_success))
            showBottomSheet = false
        } catch (_: Exception) {
            snackbarHostState.showSnackbar(context.getString(R.string.unsubscribe_error))
        } finally {
            isActionInProgress = false
        }
    }

    val requestNotificationPermission = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        val shouldRetrySubscribe = retrySubscribeAfterPermissionGrant
        retrySubscribeAfterPermissionGrant = false
        if (isGranted && shouldRetrySubscribe) {
            coroutineScope.launch { runSubscribeAction() }
        } else if (!isGranted) {
            coroutineScope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.subscribe_permission_required))
            }
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        modifier = modifier
    ) { padding ->
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            val density = LocalDensity.current
            val canvasWidthPx = with(density) { maxWidth.toPx() }
            val canvasHeightPx = with(density) { maxHeight.toPx() }
            Canvas(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            controller.panByPixels(
                                dragAmount.x, dragAmount.y,
                                canvasWidthPx, canvasHeightPx
                            )
                        }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures { offset ->
                            controller.handleTap(
                                offset.x, offset.y,
                                canvasWidthPx, canvasHeightPx
                            )
                        }
                    }
            ) {
                @Suppress("UNUSED_EXPRESSION")
                renderVersion

                val projection: (LatLng) -> Pair<Float, Float> = { latLng ->
                    controller.geoToScreen(latLng.lat, latLng.lon, canvasWidthPx, canvasHeightPx)
                }

                with(drawContext.canvas.nativeCanvas) {
                    renderer.renderOblasts(this, oblasts, projection, darkMode)
                    renderer.renderActiveAlerts(this, activeAlerts, projection)
                    renderer.renderSubscriptionMarkers(this, subscriptionPins, projection)
                    renderer.renderOblastNames(this, oblasts, projection, darkMode)
                    renderer.renderOblastCenters(this, oblasts, projection, darkMode)
                }
            }

            Column(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(bottom = 20.dp, start = 15.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ZoomControlButton(
                    onClick = { controller.zoomIn(canvasWidthPx, canvasHeightPx) },
                    icon = Icons.Default.Add,
                    darkMode = darkMode
                )
                ZoomControlButton(
                    onClick = { controller.zoomOut(canvasWidthPx, canvasHeightPx) },
                    icon = Icons.Default.Remove,
                    darkMode = darkMode
                )
            }

            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center)
                )
            }

            errorMessage?.let { error ->
                Column(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("Error: $error", color = Color.Red)
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(onClick = {
                        coroutineScope.launch {
                            isLoading = true
                            errorMessage = null
                            try {
                                val apiBaseUrl = repository.loadApiBaseUrl()
                                val loadedOblasts = repository.fetchSimplifiedOblastMap(apiBaseUrl)
                                controller.updateOblasts(loadedOblasts)
                            } catch (e: Exception) {
                                errorMessage = e.message ?: "Failed to load map data"
                            } finally {
                                isLoading = false
                            }
                        }
                    }) {
                        Text("Retry")
                    }
                }
            }
        }
    }

    // Bottom sheet
    if (showBottomSheet) {
        ModalBottomSheet(
            onDismissRequest = {
                retrySubscribeAfterPermissionGrant = false
                showBottomSheet = false
            },
            sheetState = sheetState,
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            SimplifiedBottomSheetContent(
                resolvedPoint = resolvedPoint,
                isResolvingPoint = isResolvingPoint,
                resolveError = resolveError,
            )
        }
    }
}

private fun Context.hasNotificationPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}

// ─── Bottom sheet content ─────────────────────────────────────────────────────

@Composable
private fun SimplifiedBottomSheetContent(
    resolvedPoint: ResolvedPoint?,
    isResolvingPoint: Boolean,
    resolveError: String?,
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

        if (region.oblastUid != null) {
            OblastHistorySection(history = region.oblastHistory)
        } else {
            Text(
                text = "История тревог недоступна",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ─── Region hierarchy ──────────────────────────────────────────────────────────

@Composable
private fun RegionHierarchySection(region: ResolvedRegion) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RegionRow(labelRes = R.string.region_label_hromada, title = region.hromadaTitleUk, status = region.hromadaStatus)
        if (region.raionTitleUk != null && region.raionStatus != null) {
            RegionRow(labelRes = R.string.region_label_raion, title = region.raionTitleUk, status = region.raionStatus)
        }
        if (region.oblastTitleUk != null && region.oblastStatus != null) {
            RegionRow(labelRes = R.string.region_label_oblast, title = region.oblastTitleUk, status = region.oblastStatus)
        }
    }
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

@Composable
private fun statusColor(status: String): Color = when (status) {
    "A" -> Color(0xFFD7263D)
    "P" -> Color(0xFFF4A259)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

// ─── Alert duration ────────────────────────────────────────────────────────────

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

// ─── Oblast history ────────────────────────────────────────────────────────────

@Composable
private fun OblastHistorySection(history: OblastAlertHistory) {
    if (history.active.isEmpty() && history.today.isEmpty() && history.yesterday.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = "Історія тривог по області",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        val longLastingActive = mutableListOf<OblastAlertHistoryItem>()
        val shortActiveItems = mutableListOf<OblastAlertHistoryItem>()

        for (item in history.active) {
            if (isAlertUnder24h(item.startedAt)) shortActiveItems.add(item) else longLastingActive.add(item)
        }

        val todayItems = shortActiveItems + history.today

        HistoryGroup(title = "Довготривалі тривоги", items = longLastingActive)
        HistoryGroup(title = "Сьогодні", items = todayItems)
        HistoryGroup(title = "Вчора", items = history.yesterday)
    }
}

private fun isAlertUnder24h(startedAt: String): Boolean {
    return try {
        Duration.between(parseBackendInstant(startedAt), Instant.now()).toHours() < 24
    } catch (_: Exception) { true }
}

@Composable
private fun HistoryGroup(title: String, items: List<OblastAlertHistoryItem>) {
    if (items.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        items.forEach { item -> AggregatedRaionCard(item = item) }
    }
}

private fun alertTypeCardColor(alertType: String?, isActive: Boolean): Color = when {
    !isActive -> Color(0xFF585D64)
    alertType == "artillery_shelling" -> Color(0xFFB35800)
    alertType == "urban_fights" -> Color(0xFF3A2D88)
    else -> Color(0xFF762B2D)
}

private fun alertTypeBadgeColor(alertType: String?): Color = when (alertType) {
    "artillery_shelling" -> Color(0xFF7A3A00)
    "urban_fights" -> Color(0xFF2A1F6A)
    else -> Color(0xFF5A1F21)
}

@Composable
private fun AggregatedRaionCard(item: OblastAlertHistoryItem) {
    val background = alertTypeCardColor(item.alertType, isActive = item.isActive)
    val titleColor = Color(0xFFE9EDF2)

    val timeLabel = if (item.isActive) {
        val timeDesc = formatHistoryPointInTime(item.startedAt)
        val duration = formatDurationCompact(item.startedAt, null)
        "$timeDesc Триває вже $duration"
    } else {
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
        "artillery_shelling" -> "leaflet/icons/artillery-shelling.png"
        "urban_fights" -> "leaflet/icons/urban-fights.png"
        else -> "leaflet/icons/air-raid.png"
    }
    val label = when (alertType) {
        "artillery_shelling" -> "Загроза артобстрілу"
        "urban_fights" -> "Загроза вуличних боїв"
        else -> "Повітряна тривога"
    }
    val badgeBg = alertTypeBadgeColor(alertType)

    val bitmap = remember(assetPath) {
        runCatching {
            context.assets.open(assetPath).use { android.graphics.BitmapFactory.decodeStream(it) }
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

// ─── Time formatting helpers ───────────────────────────────────────────────────

private fun formatHistoryPointInTime(startedAt: String): String {
    return try {
        val zone = ZoneId.of("Europe/Kyiv")
        val start = parseBackendInstant(startedAt).atZone(zone)
        val now = Instant.now().atZone(zone)
        formatAlertStartLabel(start, now)
    } catch (_: Exception) { startedAt }
}

private fun formatDurationCompact(startedAt: String, endedAt: String?): String {
    return try {
        val startInstant = parseBackendInstant(startedAt)
        val endInstant = endedAt?.let { parseBackendInstant(it) }
        formatDurationCompact(startInstant, endInstant)
    } catch (_: Exception) { "—" }
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