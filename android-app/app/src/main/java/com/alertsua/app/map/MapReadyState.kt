package com.alertsua.app.map

/**
 * Флаг первой отрисовки карты. Splash-экран держится, пока стиль не загружен;
 * сбрасывается только вместе с процессом (смена темы перезагружает стиль,
 * но UI уже виден — держать splash повторно не нужно).
 */
object MapReadyState {
    @Volatile
    var isMapReady: Boolean = false
}
