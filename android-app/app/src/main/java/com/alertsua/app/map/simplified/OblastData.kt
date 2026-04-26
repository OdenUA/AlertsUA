package com.alertsua.app.map.simplified

data class LatLng(val lat: Double, val lon: Double)

data class Bounds(
    val west: Double,
    val south: Double,
    val east: Double,
    val north: Double
)

data class OblastData(
    val uid: Int,
    val titleUk: String,
    val status: String,
    val alertType: String,
    val geometry: List<List<List<Double>>>,
    val center: LatLng,      // Geographic center for label position
    val cityCenter: LatLng,  // Oblast capital city for marker position
    val bounds: Bounds
)
