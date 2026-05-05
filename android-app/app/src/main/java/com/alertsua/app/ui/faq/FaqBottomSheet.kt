package com.alertsua.app.ui.faq

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowRight
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.alertsua.app.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FaqBottomSheet(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val faqItems = listOf(
        FAQItem(
            question = "Що це за додаток?",
            answer = "Додаток Тривога UA відображає інформацію про повітряні тривоги та інші загрози на мапі України.\nСервіс розроблений і підтримується незалежним розробником."
        ),
        FAQItem(
            question = "Чи є додаток офіційним джерелом інформації?",
            answer = "Ні, додаток не є офіційним джерелом інформації та не пов'язаний з державними органами. Це незалежний проєкт, який використовує дані з офіційних джерел."
        ),
        FAQItem(
            question = "Звідки отримуєте дані про тривоги?",
            answer = "Канал \"Повітряна тривога\", Офіційне API \"Повітряна тривога\" \nОфіційний канал, що повідомляє про повітряні тривоги та інші загрози."
        ),
        FAQItem(
            question = "Як отримувати сповищення щодо повітряних тривог",
            answer = "Для отримання сповіщень щодо повітряних тривог, необхідно натиснути на потрібне місце на карті та натиснути кнопку \"Підписатися\""
        ),
        FAQItem(
            question = "Що означають кнопки у додатку?",
            answer = "![tg.png](tg.png) - Активує режим спостереження за рухом об'єктів. Якщо з'явиться інформація про переміщення БпЛА чи ракет у телеграм-каналі Повітряних Сил України, на мапі автоматично з'явиться іконка загрози та приблизне напрямок руху.\n" +
                    "Натиснувши на іконку загрози, можна побачити повідомлення з офіційного телеграм-каналу «Повітряні сили ЗСУ» щодо цієї загрози \n" +
                    "Зверніть увагу, що дані про рух об'єктів є орієнтовними та надходять із певною затримкою, без деталізації. \n" +
                    "Отримана інформація базується на автоматичному аналізі текстової інформації з офіційного каналу «Повітряні сили ЗСУ» із використанням штучного інтелекту.\n" +
                    "В процесі аналізу можуть виникати помилки та неточності пов'язані з неоднозначністю трактувань, застосування невідомих системі формулювань та інших нюансів пов'язаних з роботою ШІ.\n" +
                    "Через це ми не можемо гарантувати стовідсоткову достовірність і відповідність інформації реальній ситуації.\n" +
                    "Ми постійно працюємо над удосконаленням системи, з метою зменшення можливих неточностей і покращення якості наданої інформації.\n" +
                    "❗Не використовуйте цю інформацію для прийняття рішень, пов'язаних з особистою безпекою.\n" +
                    "![refresh.png](refresh.png) - Примусове оновлення даних\n" +
                    "![map.png](map.png) - Перехід на спрощену мапу. Спрощений варіант відображає лише повітряні тривоги на рівні районів, проте значно швидше працює і сумісний з більшою кількістю телефонів.\n" +
                    "![theme.png](theme.png) - Зміна теми додатку: Світла/Темна\n" +
                    "![fullscreen.png](fullscreen.png) - Повноекранний режим"
        ),
        FAQItem(
            question = "Написати нам",
            answer = "Натисніть цю кнопку, щоб відкрити програму електронної пошти та надіслати листа на адресу alertuaapp@gmail.com з темою \"Питання щодо додатку Тривога UA\""
        )
    )

    var expandedIndex by remember { mutableIntStateOf(-1) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Card(
            modifier = modifier
                .fillMaxWidth()
                .heightIn(max = 600.dp),
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface
            )
        ) {
            Column(
                modifier = Modifier.fillMaxSize()
            ) {
                // Заголовок
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Питання - Відповіді",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold
                    )
                }

                // Список вопросов и ответов
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                ) {
                    faqItems.forEachIndexed { index, item ->
                        FAQItemView(
                            item = item,
                            isExpanded = expandedIndex == index,
                            onToggle = {
                                expandedIndex = if (expandedIndex == index) -1 else index
                            },
                            onEmailClick = {
                                sendEmail(context)
                            }
                        )
                    }
                }

                // Кнопка закрытия
                Button(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    onClick = onDismiss,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary
                    )
                ) {
                    Text("Закрити")
                }
            }
        }
    }
}

@Composable
private fun FAQItemView(
    item: FAQItem,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    onEmailClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = if (isExpanded && item.question != "Написати нам")
                    MaterialTheme.colorScheme.primaryContainer
                else
                    Color.Transparent,
                shape = RoundedCornerShape(8.dp)
            )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null
                ) {
                    if (item.question == "Написати нам") {
                        onEmailClick()
                    } else {
                        onToggle()
                    }
                }
                .background(
                    if (item.question == "Написати нам")
                        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
                    else
                        Color.Transparent
                )
                .padding(horizontal = 16.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = item.question,
                style = MaterialTheme.typography.bodyLarge,
                color = if (item.question == "Написати нам")
                    MaterialTheme.colorScheme.primary
                else if (isExpanded)
                    MaterialTheme.colorScheme.onPrimaryContainer
                else
                    MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f)
            )

            if (item.question == "Написати нам") {
                Icon(
                    imageVector = Icons.Outlined.Email,
                    contentDescription = "Написати лист",
                    tint = MaterialTheme.colorScheme.primary
                )
            }
            // Прибираємо кнопку розгортання
        }

        if (isExpanded && item.question != "Написати нам") {
            Spacer(modifier = Modifier.height(8.dp))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                // Заменяем маркеры иконок на реображение с иконками
                val parts = item.answer.split("\\n".toRegex())

                parts.forEach { line ->
                    if (line.isNotEmpty()) {
                        when {
                            line.contains("tg.png") -> {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    // Используем оригинальную tg.png иконку
                                    Icon(
                                        painter = painterResource(R.drawable.tg),
                                        contentDescription = "Режим спостереження",
                                        modifier = Modifier.size(24.dp),
                                        tint = Color.Unspecified // отключаем tint для PNG
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = "• Активує режим спостереження за рухом об'єктів.",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        lineHeight = 26.sp
                                    )
                                }
                            }
                            line.contains("refresh.png") -> {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.refresh),
                                        contentDescription = "Оновлення даних",
                                        modifier = Modifier.size(24.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = "• Примусове оновлення даних",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        lineHeight = 26.sp
                                    )
                                }
                            }
                            line.contains("map.png") -> {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.map),
                                        contentDescription = "Спрощена мапа",
                                        modifier = Modifier.size(24.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = "• Перехід на спрощену мапу",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        lineHeight = 26.sp
                                    )
                                }
                            }
                            line.contains("theme.png") -> {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.theme),
                                        contentDescription = "Зміна теми",
                                        modifier = Modifier.size(24.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = "• Зміна теми додатку: Світла/Темна",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        lineHeight = 26.sp
                                    )
                                }
                            }
                            line.contains("fullscreen.png") -> {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.fullscreen),
                                        contentDescription = "Повноекранний режим",
                                        modifier = Modifier.size(24.dp),
                                        tint = MaterialTheme.colorScheme.primary
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = "• Повноекранний режим",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        lineHeight = 26.sp
                                    )
                                }
                            }
                            else -> {
                                Text(
                                    text = line,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    lineHeight = 22.sp,
                                    modifier = Modifier.padding(start = 36.dp)
                                )
                            }
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

// Helper function to open email intent
private fun sendEmail(context: android.content.Context) {
    try {
        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "message/rfc822"
            putExtra(android.content.Intent.EXTRA_EMAIL, arrayOf("alertuaapp@gmail.com"))
            putExtra(android.content.Intent.EXTRA_SUBJECT, "Питання щодо додатку Тривога UA")
        }
        context.startActivity(android.content.Intent.createChooser(intent, "Відправити email"))
    } catch (e: Exception) {
        android.widget.Toast.makeText(
            context,
            "Не вдалося відкрити поштову програму",
            android.widget.Toast.LENGTH_SHORT
        ).show()
    }
}

data class FAQItem(
    val question: String,
    val answer: String
)