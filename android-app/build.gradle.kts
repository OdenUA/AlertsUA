plugins {
    id("com.android.application") version "9.3.2" apply false
    id("com.google.gms.google-services") version "4.5.0" apply false
    // AGP 9.x: Kotlin поддержка встроена (Kotlin 2.2.10), плагин org.jetbrains.kotlin.android
    // больше не применяется. Compose-компилятор подключается отдельным плагином
    // той же версии, что и встроенный Kotlin.
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
}
