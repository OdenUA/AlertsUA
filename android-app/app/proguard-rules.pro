# Правила ProGuard/R8 для Тривога UA
# Цель: не допустить удаления/обфускации классов, которые используются рефлексией,
# системными сервисами, JavaScript-интерфейсом WebView и Compose Runtime.

# --- Аннотации и метаданные ---
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-keepattributes RuntimeVisibleAnnotations
-keepattributes KotlinMetadata

# --- Собственные классы приложения ---
# Сохраняем все классы в пакете com.alertsua.app, чтобы R8 не обфусцировал/удалил
# DTO, репозитории, UI-состояния и методы, используемые через рефлексию.
-keep class com.alertsua.app.** { *; }
-keepclassmembers class com.alertsua.app.** { *; }

# --- Компоненты Android ---
-keep class * extends android.app.Activity
-keep class * extends android.app.Application
-keep class * extends android.app.Service
-keep class * extends android.content.BroadcastReceiver
-keep class * extends android.content.ContentProvider

# --- Parcelable / Serializable ---
-keep class * implements android.os.Parcelable { *; }
-keep class * implements java.io.Serializable { *; }

# --- JavaScript-интерфейс WebView ---
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- Compose ---
# Сохраняем аннотированные @Composable функции и связанные с ними состояния.
-keepclassmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class * {
    @androidx.compose.runtime.ReadOnlyComposable <methods>;
}

# --- Kotlin Coroutines ---
-keepclassmembers class kotlinx.coroutines.** { *; }
-keepclassmembers class kotlin.coroutines.** { *; }
-dontwarn kotlinx.coroutines.**

# --- Firebase и Play Services ---
# Библиотеки уже содержат consumer ProGuard rules, но добавляем явно на всякий случай.
-keep class com.google.firebase.** { *; }
-keepclassmembers class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-keepclassmembers class com.google.android.gms.** { *; }

# --- AndroidX ---
-keep class androidx.core.** { *; }
-keep class androidx.fragment.** { *; }
-keep class androidx.lifecycle.** { *; }
-keep class androidx.webkit.** { *; }

# --- Логирование: вырезаем android.util.Log из release ---
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
}

# --- Suppress warnings ---
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
