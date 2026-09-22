package com.alertsua.app.data

import android.content.Context
import android.os.Build
import com.alertsua.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

data class SubscriptionPin(
    val subscriptionId: String,
    val lat: Double,
    val lon: Double,
    val levelLabel: String? = null,
)

data class OblastAlertHistoryItem(
    val regionTitleUk: String,
    val raionTitleUk: String?,
    val startedAt: String,
    val endedAt: String?,
    val alertType: String? = "air_raid",
) {
    /** Явный флаг активности: true если endedAt == null, false в противном случае */
    val isActive: Boolean
        get() = endedAt == null
}

data class OblastAlertHistory(
    val active: List<OblastAlertHistoryItem>,
    val today: List<OblastAlertHistoryItem>,
    val yesterday: List<OblastAlertHistoryItem>,
)

data class ResolvedRegion(
  val leafUid: Int,
  val leafType: String,
  // Hromada level
  val hromadaTitleUk: String,
  val hromadaStatus: String,
  // Raion level
  val raionUid: Int?,
  val raionTitleUk: String?,
  val raionStatus: String?,
  // Oblast level
  val oblastUid: Int?,
  val oblastTitleUk: String?,
  val oblastStatus: String?,
  // Active alert start time (ISO 8601), null if no active alert
  val activeFrom: String?,
  // Oblast-wide alert history (active/today/yesterday)
  val oblastHistory: OblastAlertHistory,
)

data class ResolvedPoint(
    val latitude: Double,
    val longitude: Double,
    val addressUk: String,
    val resolvedRegion: ResolvedRegion,
)

class AlertsRepository(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun loadApiBaseUrl(): String {
        val storedValue = preferences.getString(KEY_API_BASE_URL, "http://173.242.53.129/api/v1").orEmpty()
        val normalizedValue = normalizeApiBaseUrl(storedValue)
        if (normalizedValue == LEGACY_EMULATOR_API_BASE_URL) {
            saveApiBaseUrl("http://173.242.53.129/api/v1")
            return "http://173.242.53.129/api/v1"
        }

        return normalizedValue
    }

    fun saveApiBaseUrl(rawValue: String) {
        preferences.edit().putString(KEY_API_BASE_URL, normalizeApiBaseUrl(rawValue)).apply()
    }

    fun saveDarkModeEnabled(isEnabled: Boolean) {
        preferences.edit().putBoolean(KEY_DARK_MODE_ENABLED, isEnabled).apply()
    }

    /** null — тема ещё не задана (первый запуск), иначе сохранённое значение */
    fun loadDarkModeEnabled(): Boolean? =
        if (preferences.contains(KEY_DARK_MODE_ENABLED)) {
            preferences.getBoolean(KEY_DARK_MODE_ENABLED, false)
        } else {
            null
        }

    fun normalizeApiBaseUrl(rawValue: String): String {
        val trimmed = rawValue.trim().removeSuffix("/")
        if (trimmed.isBlank()) {
            return "http://173.242.53.129/api/v1"
        }

        return when {
            trimmed.endsWith("/api/v1") -> trimmed
            trimmed.endsWith("/api/v1/") -> trimmed.removeSuffix("/")
            else -> "$trimmed/api/v1"
        }
    }

    suspend fun resolvePoint(
        rawApiBaseUrl: String,
        latitude: Double,
        longitude: Double,
    ): ResolvedPoint = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val connection = (URL("$apiBaseUrl/subscriptions/resolve-point").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "POST"
                doInput = true
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
            }

        try {
            val requestBody = JSONObject()
                .put("latitude", latitude)
                .put("longitude", longitude)
                .toString()

            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                writer.write(requestBody)
            }

            val responseCode = connection.responseCode
            val responseText = readResponse(connection)

            if (responseCode !in 200..299) {
                throw IllegalStateException(extractErrorMessage(responseText))
            }

            parseResolvedPoint(JSONObject(responseText))
        } finally {
            connection.disconnect()
        }
    }

    private fun readResponse(connection: HttpURLConnection): String {
        val stream = connection.inputStreamOrNull() ?: connection.errorStream ?: return ""
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    private fun parseResolvedPoint(json: JSONObject): ResolvedPoint {
        val r = json.getJSONObject("resolved_region")
        val historyJson = r.optJSONObject("oblast_history") ?: JSONObject()

        fun parseHistoryItems(key: String): List<OblastAlertHistoryItem> {
            val arr = historyJson.optJSONArray(key) ?: return emptyList()
            return (0 until arr.length()).mapNotNull { index ->
                val item = arr.optJSONObject(index) ?: return@mapNotNull null
                val regionTitle = item.optString("region_title_uk").ifBlank { return@mapNotNull null }
                OblastAlertHistoryItem(
                    regionTitleUk = regionTitle,
                    raionTitleUk = item.optString("raion_title_uk").ifBlank { null },
                    startedAt = item.optString("started_at").ifBlank { return@mapNotNull null },
                    endedAt = if (item.isNull("ended_at")) null else item.optString("ended_at").ifBlank { null },
                    alertType = item.optString("alert_type").ifBlank { "air_raid" },
                )
            }
        }

        return ResolvedPoint(
            latitude  = json.getDouble("latitude"),
            longitude = json.getDouble("longitude"),
            addressUk = json.getString("address_uk"),
            resolvedRegion = ResolvedRegion(
                leafUid        = r.getInt("leaf_uid"),
                leafType       = r.getString("leaf_type"),
                hromadaTitleUk = r.getString("hromada_title_uk"),
                hromadaStatus  = r.optString("hromada_status", " "),
                raionUid       = r.optIntOrNull("raion_uid"),
                raionTitleUk   = if (r.isNull("raion_title_uk")) null else r.optString("raion_title_uk").ifEmpty { null },
                raionStatus    = if (r.isNull("raion_status")) null else r.optString("raion_status").ifEmpty { null },
                oblastUid      = r.optIntOrNull("oblast_uid"),
                oblastTitleUk  = if (r.isNull("oblast_title_uk")) null else r.optString("oblast_title_uk").ifEmpty { null },
                oblastStatus   = if (r.isNull("oblast_status")) null else r.optString("oblast_status").ifEmpty { null },
                activeFrom     = if (r.isNull("active_from")) null else r.optString("active_from").ifEmpty { null },
                oblastHistory  = OblastAlertHistory(
                    active = parseHistoryItems("active"),
                    today = parseHistoryItems("today"),
                    yesterday = parseHistoryItems("yesterday"),
                ),
            ),
        )
    }

    private fun extractErrorMessage(responseText: String): String {
        if (responseText.isBlank()) {
            return "Не вдалося з'єднатися із сервером."
        }

        return runCatching {
            val json = JSONObject(responseText)
            if (json.has("error")) {
                json.getJSONObject("error").optString("message_uk")
            } else {
                json.optString("message")
            }
        }.getOrNull().orEmpty().ifBlank {
            "Не вдалося визначити вибране місце."
        }
    }

    private fun HttpURLConnection.inputStreamOrNull(): InputStream? =
        runCatching { inputStream }.getOrNull()

    private fun JSONObject.optIntOrNull(key: String): Int? = if (isNull(key)) null else getInt(key)

    fun saveFcmToken(token: String) {
        preferences.edit().putString(KEY_FCM_TOKEN, token).apply()
    }

    fun loadFcmToken(): String? = preferences.getString(KEY_FCM_TOKEN, null)

    fun saveInstallationToken(token: String) {
        preferences.edit().putString(KEY_INSTALLATION_TOKEN, token).apply()
    }

    fun loadInstallationToken(): String? = preferences.getString(KEY_INSTALLATION_TOKEN, null)

    fun getAndroidId(): String {
        if (cachedAndroidId != null) return cachedAndroidId!!

        val androidId = try {
            android.provider.Settings.Secure.getString(
                appContext.contentResolver,
                android.provider.Settings.Secure.ANDROID_ID
            )
        } catch (e: Exception) {
            ""
        }
        cachedAndroidId = androidId
        return androidId
    }

    private var cachedAndroidId: String? = null

    /**
     * Updates the FCM token on the server. Should be called when the app starts
     * or when Firebase provides a new token to ensure push notifications work.
     */
    suspend fun updateFcmToken(rawApiBaseUrl: String): Unit = withContext(Dispatchers.IO) {
        val fcmToken = loadFcmToken() ?: return@withContext
        val installToken = loadInstallationToken() ?: return@withContext

        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val connection = (URL("$apiBaseUrl/installations/me/push-token").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "PUT"
                doInput = true
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $installToken")
            }

        try {
            val body = JSONObject()
                .put("fcm_token", fcmToken)
                .toString()

            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                writer.write(body)
            }

            val code = connection.responseCode
            if (code in 200..299) {
                android.util.Log.i("AlertsRepository", "FCM token updated successfully")
            } else {
                android.util.Log.w("AlertsRepository", "FCM token update failed: $code ${readResponse(connection)}")
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Registers this device installation with the backend and stores the returned
     * installation_token. Safe to call multiple times – skips if already registered.
     */
    suspend fun ensureInstallationRegistered(rawApiBaseUrl: String): Unit = withContext(Dispatchers.IO) {
        if (loadInstallationToken() != null) return@withContext

        val fcmToken = loadFcmToken() ?: return@withContext  // wait until FCM token is available
        val androidId = getAndroidId()

        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val connection = (URL("$apiBaseUrl/installations").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "POST"
                doInput = true
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
            }
        try {
            val body = JSONObject()
                .put("platform", "android")
                .put("locale", "uk-UA")
                .put("app_version", "0.2.0")
                .put("app_build", "7")
                .put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".take(128))
                .put("fcm_token", fcmToken)
                .put("notifications_enabled", true)
                .apply {
                    if (androidId.isNotBlank()) {
                        put("android_id", androidId)
                    }
                }
                .toString()
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(body)
                }
            val code = connection.responseCode
            val text = readResponse(connection)
            if (code in 200..299) {
                val token = JSONObject(text).optString("installation_token", "")
                if (token.isNotBlank()) saveInstallationToken(token)
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Creates a subscription for push notifications at a given point.
     * Uses installation_token (from registration) as the Bearer auth token.
     */
    suspend fun subscribeToPoint(
        rawApiBaseUrl: String,
        latitude: Double,
        longitude: Double,
        levelLabel: String,
    ): String = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val installToken = loadInstallationToken()
            ?: throw IllegalStateException("NO_INSTALLATION_TOKEN")

        val connection = (URL("$apiBaseUrl/subscriptions").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "POST"
                doInput = true
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $installToken")
            }

        try {
            val body = JSONObject()
                .put("latitude", latitude)
                .put("longitude", longitude)
                .put("notify_on_start", true)
                .put("notify_on_end", true)
                .put("label_user", levelLabel)
                .toString()

            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(body)
                }

            val code = connection.responseCode
            val responseText = readResponse(connection)
            if (code !in 200..299) {
                throw IllegalStateException(extractErrorMessage(responseText))
            }
            JSONObject(responseText).getString("subscription_id")
        } finally {
            connection.disconnect()
        }
    }

    suspend fun fetchSubscriptions(rawApiBaseUrl: String): List<SubscriptionPin> = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val androidId = getAndroidId()

        // First try: fetch with installation token
        val installToken = loadInstallationToken()
        if (installToken != null) {
            val pins = fetchSubscriptionsWithToken(apiBaseUrl, installToken, androidId)
            if (pins.isNotEmpty()) {
                return@withContext pins
            }
        }

        // Fallback: try to fetch by android_id (for reinstalled apps or cleared cache)
        if (androidId.isNotBlank()) {
            android.util.Log.d("AlertsRepository", "No installation token or no subscriptions via token, trying android_id: $androidId")
            val pins = fetchSubscriptionsByAndroidId(apiBaseUrl, androidId)
            if (pins.isNotEmpty()) {
                return@withContext pins
            }
        }

        // Last resort: ensure installation is registered, then try again
        if (installToken == null) {
            android.util.Log.d("AlertsRepository", "No token and no subscriptions via android_id, ensuring installation is registered")
            ensureInstallationRegistered(rawApiBaseUrl)
            val newToken = loadInstallationToken()
            if (newToken != null) {
                val pins = fetchSubscriptionsWithToken(apiBaseUrl, newToken, androidId)
                if (pins.isNotEmpty()) {
                    return@withContext pins
                }
            }
            // Final fallback: try android_id again (server may have created new installation)
            if (androidId.isNotBlank()) {
                return@withContext fetchSubscriptionsByAndroidId(apiBaseUrl, androidId)
            }
        }

        emptyList()
    }

    private suspend fun fetchSubscriptionsWithToken(apiBaseUrl: String, installToken: String, androidId: String?): List<SubscriptionPin> {
        val urlBuilder = StringBuilder("$apiBaseUrl/subscriptions")
        val params = mutableListOf<String>()
        if (!androidId.isNullOrBlank()) {
            params.add("android_id=$androidId")
        }
        if (params.isNotEmpty()) {
            urlBuilder.append("?").append(params.joinToString("&"))
        }

        val connection = (URL(urlBuilder.toString()).openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "GET"
                doInput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $installToken")
            }

        try {
            val code = connection.responseCode
            val responseText = readResponse(connection)
            if (code !in 200..299) return emptyList()

            val response = JSONObject(responseText)

            // If android_id was used and server returned a new installation token, save it
            val newInstallToken = response.optString("installation_token", "")
            if (!androidId.isNullOrBlank() && newInstallToken.isNotBlank()) {
                saveInstallationToken(newInstallToken)
                android.util.Log.d("AlertsRepository", "Saved new installation token from android_id lookup")
            }

            val arr = response.getJSONArray("subscriptions")
            return (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                SubscriptionPin(
                    subscriptionId = obj.getString("subscription_id"),
                    lat = obj.getDouble("latitude"),
                    lon = obj.getDouble("longitude"),
                    levelLabel = if (obj.isNull("label_user")) null else obj.optString("label_user").ifBlank { null },
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun fetchSubscriptionsByAndroidId(apiBaseUrl: String, androidId: String): List<SubscriptionPin> {
        val connection = (URL("$apiBaseUrl/subscriptions?android_id=$androidId").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "GET"
                doInput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Accept", "application/json")
            }

        try {
            val code = connection.responseCode
            if (code !in 200..299) return emptyList()
            val responseText = readResponse(connection)
            val response = JSONObject(responseText)

            // Save installation token if provided
            val newInstallToken = response.optString("installation_token", "")
            if (newInstallToken.isNotBlank()) {
                saveInstallationToken(newInstallToken)
                android.util.Log.d("AlertsRepository", "Saved installation token from android_id lookup")
            }

            val arr = response.getJSONArray("subscriptions")
            return (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                SubscriptionPin(
                    subscriptionId = obj.getString("subscription_id"),
                    lat = obj.getDouble("latitude"),
                    lon = obj.getDouble("longitude"),
                    levelLabel = if (obj.isNull("label_user")) null else obj.optString("label_user").ifBlank { null },
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun deleteSubscription(
        rawApiBaseUrl: String,
        subscriptionId: String,
    ): Unit = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val installToken = loadInstallationToken()
            ?: throw IllegalStateException("NO_INSTALLATION_TOKEN")

        val connection = (URL("$apiBaseUrl/subscriptions/$subscriptionId").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "DELETE"
                doInput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Authorization", "Bearer $installToken")
            }
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                throw IllegalStateException("Не вдалося відписатися.")
            }
        } finally {
            connection.disconnect()
        }
    }

    fun saveSubscriptionPins(pins: List<SubscriptionPin>) {
        val json = JSONArray().also { arr ->
            pins.forEach { pin ->
                arr.put(JSONObject().apply {
                    put("id", pin.subscriptionId)
                    put("lat", pin.lat)
                    put("lon", pin.lon)
                    put("level_label", pin.levelLabel)
                })
            }
        }
        preferences.edit().putString(KEY_SUBSCRIPTION_PINS, json.toString()).apply()
    }

    fun loadSubscriptionPins(): List<SubscriptionPin> {
        val stored = preferences.getString(KEY_SUBSCRIPTION_PINS, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(stored)
            (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                SubscriptionPin(
                    subscriptionId = obj.getString("id"),
                    lat = obj.getDouble("lat"),
                    lon = obj.getDouble("lon"),
                    levelLabel = if (obj.has("level_label") && !obj.isNull("level_label")) {
                        obj.optString("level_label").ifBlank { null }
                    } else {
                        null
                    },
                )
            }
        }.getOrDefault(emptyList())
    }

    private companion object {
        const val LEGACY_EMULATOR_API_BASE_URL = "http://10.0.2.2:43100/api/v1"
        const val PREFERENCES_NAME       = "alerts_ua_preferences"
        const val KEY_API_BASE_URL       = "api_base_url"
        const val KEY_DARK_MODE_ENABLED    = "dark_mode_enabled"
        const val KEY_FCM_TOKEN          = "fcm_token"
        const val KEY_INSTALLATION_TOKEN = "installation_token"
        const val KEY_SUBSCRIPTION_PINS  = "subscription_pins"
    }
}
