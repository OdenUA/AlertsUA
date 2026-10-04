package com.alertsua.app.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.delay

private const val LOCATION_UPDATE_INTERVAL_MS = 30_000L
private const val LOCATION_UPDATE_MIN_DISTANCE_M = 250f

/**
 * Живой поток обновлений геолокации: эмитит при сдвиге устройства
 * (>250 м) и не реже раза в 30 с. BALANCED_POWER — для отслеживания
 * громады достаточно ~100 м точности, GPS-чип не держим горячим.
 * Пустой flow, если разрешение не выдано.
 */
fun locationUpdates(context: Context): Flow<Location> = callbackFlow {
    val fineGranted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    val coarseGranted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    if (!fineGranted && !coarseGranted) {
        close()
        return@callbackFlow
    }

    val client = LocationServices.getFusedLocationProviderClient(context)
    val request = LocationRequest.Builder(LOCATION_UPDATE_INTERVAL_MS)
        .setMinUpdateDistanceMeters(LOCATION_UPDATE_MIN_DISTANCE_M)
        .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
        .build()
    val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { trySend(it) }
        }
    }
    client.requestLocationUpdates(request, callback, Looper.getMainLooper())
    awaitClose { client.removeLocationUpdates(callback) }
}

suspend fun getCurrentLocation(context: Context): Location? {
    val fusedLocationClient: FusedLocationProviderClient = LocationServices.getFusedLocationProviderClient(context)

    if (ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) != PackageManager.PERMISSION_GRANTED
    ) {
        return null
    }

    return try {
        // Try getCurrentLocation first (most accurate).
        // HIGH_ACCURACY, а не BALANCED: сетевой/fused-провайдер может молча
        // вернуть null (нет фикса, устаревшие Play Services), а высокий
        // приоритет принудительно поднимает GPS-провайдер.
        val location = fusedLocationClient.getCurrentLocation(
            Priority.PRIORITY_HIGH_ACCURACY,
            null
        ).await()
        if (location != null) {
            Log.d("LocationService", "Got current location: ${location.latitude}, ${location.longitude}")
            return location
        }
        Log.d("LocationService", "getCurrentLocation returned null, trying last known location")

        // Fallback to getLastKnownLocation
        val lastLocation = try {
            fusedLocationClient.lastLocation.await()
        } catch (e: Exception) {
            Log.w("LocationService", "Failed to get last known location", e)
            null
        }

        if (lastLocation != null) {
            Log.d("LocationService", "Got last known location: ${lastLocation.latitude}, ${lastLocation.longitude}")
            return lastLocation
        }

        Log.d("LocationService", "No location available (neither current nor last known)")
        null
    } catch (e: Exception) {
        Log.e("LocationService", "Error getting location", e)
        null
    }
}
