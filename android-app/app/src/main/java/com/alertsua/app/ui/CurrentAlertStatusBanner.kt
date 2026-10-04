package com.alertsua.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.alertsua.app.R
import com.alertsua.app.map.CurrentAlertBannerState

/**
 * Фіксована полоса під AdMob-банером: статус тривоги у громаді користувача
 * (по GPS). Стан — у CurrentAlertBannerState (наполняется из AlertMapScreen):
 * resolve-point даёт громаду/uid, AlertLayersManager — актуальный статус/рівень.
 */
@Composable
fun CurrentAlertStatusBanner(
    darkMode: Boolean,
    onEnableLocation: () -> Unit,
) {
    val containerColor = if (darkMode) Color(0xF014202C) else Color(0xE6FFFFFF)
    val contentColor = if (darkMode) Color(0xFFB8CFDA) else Color(0xFF1C3040)
    val borderColor = if (darkMode) Color(0xFF2A4258) else Color(0xFFCCCCCC)

    val permissionGranted = CurrentAlertBannerState.locationPermissionGranted
    val hromadaTitle = CurrentAlertBannerState.hromadaTitle
    val alertStatus = CurrentAlertBannerState.alertStatus

    val shape = RoundedCornerShape(6.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(shape)
            .background(containerColor)
            .border(1.dp, borderColor, shape)
            .then(
                if (!permissionGranted) Modifier.clickable(onClick = onEnableLocation) else Modifier
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when {
            !permissionGranted -> {
                Icon(
                    imageVector = Icons.Filled.MyLocation,
                    contentDescription = null,
                    tint = contentColor,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = stringResource(R.string.banner_enable_location),
                    style = MaterialTheme.typography.bodySmall,
                    color = contentColor,
                )
            }
            hromadaTitle == null -> {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = contentColor,
                )
                Text(
                    text = stringResource(R.string.banner_resolving_location),
                    style = MaterialTheme.typography.bodySmall,
                    color = contentColor,
                )
            }
            else -> {
                Text(
                    text = hromadaTitle,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = contentColor,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                AlertStatusPill(
                    alertStatus = alertStatus,
                    activeFrom = CurrentAlertBannerState.activeFrom,
                )
            }
        }
    }
}

@Composable
private fun AlertStatusPill(
    alertStatus: com.alertsua.app.map.AlertStatusInfo?,
    activeFrom: String?,
) {
    val isActive = alertStatus?.status == "A"
    val isYellow = alertStatus != null && isActive && alertStatus.alertLevel == "yellow"
    val pillColor = when {
        isYellow -> Color(0xFFB6994F)
        isActive -> Color(0xFFD7263D)
        else -> Color(0xFF4CAF50)
    }
    val statusText = stringResource(
        when {
            isYellow -> R.string.banner_status_yellow
            isActive -> R.string.banner_status_red
            else -> R.string.banner_status_none
        }
    )
    // Тикающие часы: длительность пересчитывается раз в 30 с, пока тревога активна
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(isActive, activeFrom) {
        if (!isActive) return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(30_000)
            nowMs = System.currentTimeMillis()
        }
    }
    val duration = if (isActive) formatAlertDuration(activeFrom, nowMs) else null

    Surface(color = pillColor, shape = RoundedCornerShape(12.dp)) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = statusText,
                color = Color.White,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
            if (isActive) {
                Text(
                    text = if (duration != null) {
                        stringResource(R.string.banner_duration_active, duration)
                    } else {
                        stringResource(R.string.banner_duration_just_now)
                    },
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 11.sp,
                    maxLines = 1,
                )
            }
        }
    }
}

// active_from из бэкенда: "2024-05-01 14:32:00+03" / "+0300" / ISO
private val TZ_OFFSET_HOURS_ONLY = Regex("([+-]\\d{2})$")
private val TZ_OFFSET_COMPACT = Regex("([+-]\\d{2})(\\d{2})$")

private fun parseBackendInstantMs(raw: String): Long? {
    return try {
        val normalized = raw.trim()
            .replace(' ', 'T')
            .replace(TZ_OFFSET_HOURS_ONLY, "$1:00")
            .replace(TZ_OFFSET_COMPACT, "$1:$2")
        java.time.OffsetDateTime.parse(normalized).toInstant().toEpochMilli()
    } catch (_: Exception) {
        null
    }
}

// «Триває вже 23 хвилини» / «2 год. 17 хв» / «1 день 4 год. 12 хв»
private fun formatAlertDuration(activeFrom: String?, nowMs: Long): String? {
    if (activeFrom.isNullOrBlank()) return null
    val startMs = parseBackendInstantMs(activeFrom) ?: return null
    val totalMinutes = ((nowMs - startMs) / 60_000L).coerceAtLeast(0L)
    if (totalMinutes < 1L) return null
    val days = totalMinutes / (24 * 60)
    val hours = (totalMinutes / 60) % 24
    val minutes = totalMinutes % 60
    return buildString {
        if (days > 0) append(pluralUk(days, "день", "дні", "днів")).append(' ')
        if (hours > 0) append(hours).append(" год. ")
        if (minutes > 0 || (days == 0L && hours == 0L)) {
            if (days == 0L && hours == 0L) {
                append(pluralUk(minutes, "хвилина", "хвилини", "хвилин"))
            } else {
                append(minutes).append(" хв.")
            }
        }
    }.trim()
}

// Український множинний: 1 хвилина, 2–4 хвилини, 5+ хвилин (11–14 — множина)
private fun pluralUk(n: Long, one: String, few: String, many: String): String {
    val mod100 = (n % 100).toInt()
    val mod10 = (n % 10).toInt()
    val word = when {
        mod100 in 11..14 -> many
        mod10 == 1 -> one
        mod10 in 2..4 -> few
        else -> many
    }
    return "$n $word"
}
