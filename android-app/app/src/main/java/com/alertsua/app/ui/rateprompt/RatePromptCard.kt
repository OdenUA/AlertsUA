package com.alertsua.app.ui.rateprompt

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.alertsua.app.R

@Composable
fun RatePromptCard(
    onRate: () -> Unit,
    onLater: () -> Unit,
    onNever: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.padding(16.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = stringResource(R.string.rate_prompt_title),
                style = MaterialTheme.typography.titleMedium
            )

            Text(
                text = stringResource(R.string.rate_prompt_message),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = onRate
                ) {
                    Text(stringResource(R.string.rate_prompt_rate))
                }

                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    onClick = onLater
                ) {
                    Text(stringResource(R.string.rate_prompt_later))
                }

                TextButton(onClick = onNever) {
                    Text(stringResource(R.string.rate_prompt_never))
                }
            }
        }
    }
}
