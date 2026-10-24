package com.alertsua.app.net

import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Общий HTTP-клиент приложения.
 *
 * Раньше каждый poll-запрос (бандл 30 c, угрозы 60 c, resolve-point) открывал
 * HttpURLConnection и закрывал сокет через disconnect() — ни одного
 * переиспользования соединения, на мобильной сети каждый тик = новый TCP +
 * радиопробуждение. Один клиент с пулом keep-alive держит соединение живым
 * между тиками. Gzip OkHttp обрабатывает прозрачно.
 */
object Http {

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .connectionPool(ConnectionPool(4, 5, TimeUnit.MINUTES))
            .retryOnConnectionFailure(true)
            .build()
    }

    /** GET, тело ответа строкой; не-2xx → IOException. */
    fun get(url: String): String {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            return response.body?.string() ?: throw IOException("Empty body")
        }
    }
}
