package com.alertsua.app.map.simplified

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove

@Composable
fun ZoomControlButton(
    onClick: () -> Unit,
    icon: ImageVector,
    darkMode: Boolean
) {
    var isPressed by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier
            .size(40.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        shape = RoundedCornerShape(8.dp)
    ) {
        IconButton(
            onClick = {
                isPressed = false
                onClick()
            },
            modifier = Modifier
                .background(
                    color = if (darkMode)
                        Color(if (isPressed) 0x2E5A7B else 0x1E4C6B)
                    else
                        Color(if (isPressed) 0xF0F0F0 else 0xFFFFFF),
                    shape = RoundedCornerShape(8.dp)
                )
        ) {
            Icon(
                imageVector = icon,
                contentDescription = if (icon == Icons.Default.Add) "Zoom in" else "Zoom out",
                tint = if (darkMode) Color(0xFFB8CFDA) else Color(0xFF1C3040),
                modifier = Modifier.size(24.dp)
            )
        }
    }
}