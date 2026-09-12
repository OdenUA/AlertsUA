# R8 ProGuard rules — Тривога UA
# Минимально необходимые правила: R8 сам обрабатывает всё остальное.

# --- Аннотации и метаданные ---
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-keepattributes RuntimeVisibleAnnotations
-keepattributes KotlinMetadata

# --- Manifest-компоненты ---
-keep class com.alertsua.app.AlertApplication
-keep class com.alertsua.app.MainActivity
-keep class com.alertsua.app.notifications.AlertFirebaseService

# --- Parcelable / Serializable ---
-keep class * implements android.os.Parcelable { *; }
-keep class * implements java.io.Serializable { *; }

# --- JavaScript-интерфейс WebView ---
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- Compose Runtime ---
-keepclassmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class * {
    @androidx.compose.runtime.ReadOnlyComposable <methods>;
}

# --- MapLibre Native (JNI / native методы) ---
-keep class org.maplibre.** { *; }
-dontwarn org.maplibre.**

# --- Логирование: вырезаем из release ---
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
}

# --- Suppress warnings ---
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
