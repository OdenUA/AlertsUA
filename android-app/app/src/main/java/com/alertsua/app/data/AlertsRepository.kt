package com.alertsua.app.data

import android.content.Context
import android.os.Build
import com.alertsua.app.BuildConfig
import com.alertsua.app.map.simplified.LatLng
import com.alertsua.app.map.simplified.Bounds
import com.alertsua.app.map.simplified.OblastData
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

data class ActiveAlertGeometry(
    val uid: Int,
    val titleUk: String,
    val regionType: String,
    val alertType: String,
    val geometry: List<List<List<Double>>>,
)

class AlertsRepository(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun loadApiBaseUrl(): String {
        val storedValue = preferences.getString(KEY_API_BASE_URL, BuildConfig.DEFAULT_API_BASE_URL).orEmpty()
        val normalizedValue = normalizeApiBaseUrl(storedValue)
        if (normalizedValue == LEGACY_EMULATOR_API_BASE_URL) {
            saveApiBaseUrl(BuildConfig.DEFAULT_API_BASE_URL)
            return BuildConfig.DEFAULT_API_BASE_URL
        }

        return normalizedValue
    }

    fun saveApiBaseUrl(rawValue: String) {
        preferences.edit().putString(KEY_API_BASE_URL, normalizeApiBaseUrl(rawValue)).apply()
    }

    fun saveDarkModeEnabled(isEnabled: Boolean) {
        preferences.edit().putBoolean(KEY_DARK_MODE_ENABLED, isEnabled).apply()
    }

    fun loadDarkModeEnabled(): Boolean = preferences.getBoolean(KEY_DARK_MODE_ENABLED, false)

    fun normalizeApiBaseUrl(rawValue: String): String {
        val trimmed = rawValue.trim().removeSuffix("/")
        if (trimmed.isBlank()) {
            return BuildConfig.DEFAULT_API_BASE_URL
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

    /**
     * Registers this device installation with the backend and stores the returned
     * installation_token. Safe to call multiple times – skips if already registered.
     */
    suspend fun ensureInstallationRegistered(rawApiBaseUrl: String): Unit = withContext(Dispatchers.IO) {
        if (loadInstallationToken() != null) return@withContext

        val fcmToken = loadFcmToken() ?: return@withContext  // wait until FCM token is available

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
                .put("app_version", BuildConfig.VERSION_NAME)
                .put("app_build", BuildConfig.VERSION_CODE.toString())
                .put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".take(128))
                .put("fcm_token", fcmToken)
                .put("notifications_enabled", true)
                .toString()
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body) }
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

            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body) }

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
        val installToken = loadInstallationToken() ?: return@withContext emptyList()

        val connection = (URL("$apiBaseUrl/subscriptions").openConnection() as HttpURLConnection)
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
            if (code !in 200..299) return@withContext emptyList()
            val arr = JSONObject(responseText).getJSONArray("subscriptions")
            (0 until arr.length()).map { i ->
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

    suspend fun fetchSimplifiedOblastMap(rawApiBaseUrl: String): List<OblastData> = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val connection = (URL("$apiBaseUrl/map/simplified-oblast").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "GET"
                doInput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Accept", "application/json")
            }

        try {
            val code = connection.responseCode
            val responseText = readResponse(connection)

            android.util.Log.d("SimplifiedMap", "API response code: $code")
            android.util.Log.d("SimplifiedMap", "Response length: ${responseText.length}")

            if (code !in 200..299) {
                android.util.Log.e("SimplifiedMap", "HTTP error: $code")
                throw IllegalStateException("Failed to load map data")
            }

            val json = JSONObject(responseText)
            val oblastsArray = json.getJSONArray("oblasts")

            android.util.Log.d("SimplifiedMap", "Oblasts count: ${oblastsArray.length()}")

            (0 until oblastsArray.length()).map { i ->
                try {
                    val obj = oblastsArray.getJSONObject(i)
                    val geometry = obj.getJSONObject("geometry")
                    val coordinates = geometry.getJSONArray("coordinates")

                    android.util.Log.d("SimplifiedMap", "Processing oblast $i: ${obj.getString("title_uk")}")
                    android.util.Log.d("SimplifiedMap", "Geometry type: ${geometry.getString("type")}")
                    android.util.Log.d("SimplifiedMap", "Coordinates length: ${coordinates.length()}")

                    val parsedGeometry = parseGeoJsonCoordinates(coordinates)
                    android.util.Log.d("SimplifiedMap", "Parsed geometry rings: ${parsedGeometry.size}")

                    OblastData(
                        uid = obj.getInt("uid"),
                        titleUk = obj.getString("title_uk"),
                        status = obj.getString("status"),
                        alertType = obj.getString("alert_type"),
                        geometry = parsedGeometry,
                        center = LatLng(
                            lat = obj.getJSONObject("center").getDouble("lat"),
                            lon = obj.getJSONObject("center").getDouble("lon")
                        ),
                        bounds = Bounds(
                            west = obj.getJSONObject("bounds").getDouble("west"),
                            south = obj.getJSONObject("bounds").getDouble("south"),
                            east = obj.getJSONObject("bounds").getDouble("east"),
                            north = obj.getJSONObject("bounds").getDouble("north")
                        )
                    )
                } catch (e: Exception) {
                    android.util.Log.e("SimplifiedMap", "Error parsing oblast $i: ${e.message}", e)
                    throw e
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("SimplifiedMap", "Error in fetchSimplifiedOblastMap: ${e.message}", e)
            throw e
        } finally {
            connection.disconnect()
        }
    }

    private fun parseGeoJsonCoordinates(coordinates: JSONArray): List<List<List<Double>>> {
        return mutableListOf<List<List<Double>>>().apply {
            if (coordinates.length() == 0) return@apply

            val firstElement = coordinates.get(0)
            if (firstElement !is JSONArray) return@apply

            // GeoJSON Polygon:   coordinates = [ ring, ... ]    where ring = [[lon,lat], ...]
            // GeoJSON MultiPolygon: coordinates = [ polygon, ... ] where polygon = [ring, ...]
            //
            // Both firstElement and secondElement are JSONArray.
            // The key distinction: check what's INSIDE secondElement.
            //   Polygon:       firstElement[0] = [lon, lat]  → firstElement[0][0] is Double
            //   MultiPolygon:  firstElement[0] = [[lon,lat],...] → firstElement[0][0] is JSONArray

            val secondElement = firstElement.get(0)
            if (secondElement !is JSONArray) return@apply

            val thirdElement = secondElement.get(0)

            if (thirdElement is JSONArray) {
                // MultiPolygon: coordinates = [ polygon, ... ]
                // polygon = [ ring, ... ], ring = [ [lon,lat], ... ]
                for (i in 0 until coordinates.length()) {
                    val polygon = coordinates.getJSONArray(i)
                    for (j in 0 until polygon.length()) {
                        val ring = polygon.getJSONArray(j)
                        add(parseRing(ring))
                    }
                }
            } else {
                // Polygon: coordinates = [ ring, ... ]
                // ring = [ [lon,lat], ... ]
                for (i in 0 until coordinates.length()) {
                    val ring = coordinates.getJSONArray(i)
                    add(parseRing(ring))
                }
            }
        }
    }

    private fun parseRing(ring: JSONArray): List<List<Double>> {
        val points = mutableListOf<List<Double>>()
        for (k in 0 until ring.length()) {
            val point = ring.getJSONArray(k)
            points.add(listOf(point.getDouble(0), point.getDouble(1)))
        }
        return points
    }

    suspend fun fetchActiveAlertGeometries(rawApiBaseUrl: String): List<ActiveAlertGeometry> = withContext(Dispatchers.IO) {
        val apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl)
        val connection = (URL("$apiBaseUrl/map/active-alerts").openConnection() as HttpURLConnection)
            .apply {
                requestMethod = "GET"
                doInput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("Accept", "application/json")
            }

        try {
            val code = connection.responseCode
            val responseText = readResponse(connection)
            if (code !in 200..299) return@withContext emptyList()

            val json = JSONObject(responseText)
            val features = json.optJSONArray("features") ?: return@withContext emptyList()

            (0 until features.length()).mapNotNull { i ->
                try {
                    val feature = features.getJSONObject(i)
                    val props = feature.getJSONObject("properties")
                    val geometry = feature.getJSONObject("geometry")
                    val coordinates = geometry.getJSONArray("coordinates")
                    ActiveAlertGeometry(
                        uid = props.getInt("uid"),
                        titleUk = props.getString("title_uk"),
                        regionType = props.getString("region_type"),
                        alertType = props.optString("alert_type", "air_raid"),
                        geometry = parseGeoJsonCoordinates(coordinates),
                    )
                } catch (_: Exception) { null }
            }
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val LEGACY_EMULATOR_API_BASE_URL = "http://10.0.2.2:43100/api/v1"
        const val PREFERENCES_NAME       = "alerts_ua_preferences"
        const val KEY_API_BASE_URL       = "api_base_url"
        const val KEY_DARK_MODE_ENABLED  = "dark_mode_enabled"
        const val KEY_FCM_TOKEN          = "fcm_token"
        const val KEY_INSTALLATION_TOKEN = "installation_token"
        const val KEY_SUBSCRIPTION_PINS  = "subscription_pins"
    }
}
