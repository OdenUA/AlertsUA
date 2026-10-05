package com.alertsua.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlin.math.roundToInt

/**
 * Единая точка декодирования asset-иконок для MapLibre.
 *
 * MapLibre требует Bitmap (не Drawable), поэтому Coil здесь не подходит —
 * вместо него LruCache с sampled-декодированием, чтобы иконки не
 * перекодировались на каждый setStyle (холодный старт, смена темы).
 */
object MapIconBitmapCache {

    private const val MAX_CACHE_BYTES = 2 * 1024 * 1024

    private val cache = object : LruCache<String, Bitmap>(MAX_CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    fun get(context: Context, assetPath: String, sizeDp: Float): Bitmap? {
        val density = context.resources.displayMetrics.density
        val target = (sizeDp * density).roundToInt().coerceAtLeast(1)
        val key = "$assetPath@$target"
        cache.get(key)?.let { return it }
        val decoded = decodeScaled(context, assetPath, target) ?: return null
        cache.put(key, decoded)
        return decoded
    }

    private fun decodeScaled(context: Context, assetPath: String, target: Int): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.assets.open(assetPath).use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= target &&
            bounds.outHeight / (sample * 2) >= target
        ) {
            sample *= 2
        }
        val raw = context.assets.open(assetPath).use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply {
                inSampleSize = sample
            })
        } ?: return null
        val scaled = Bitmap.createScaledBitmap(raw, target, target, true)
        if (scaled !== raw) raw.recycle()
        scaled
    }.getOrNull()
}
