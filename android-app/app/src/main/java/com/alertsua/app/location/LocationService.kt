package com.alertsua.app.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.delay

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
        // Try getCurrentLocation first (most accurate)
        val location = fusedLocationClient.getCurrentLocation(
            Priority.PRIORITY_BALANCED_POWER_ACCURACY,
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
