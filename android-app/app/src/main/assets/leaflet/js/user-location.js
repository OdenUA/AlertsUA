// Маркер текущего местоположения пользователя.
// Координаты приходят из нативной стороны (MapController.setUserLocation),
// либо из браузерной геолокации как fallback при отладке вне WebView.
let userLocationMarker = null;

window.setUserLocation = function(lat, lon, center) {
    runWhenReady(function() {
        var latLng = [lat, lon];
        if (userLocationMarker) {
            userLocationMarker.setLatLng(latLng);
        } else {
            var icon = L.divIcon({
                className: '',
                html: '<div class="user-location-marker"><div class="user-location-dot"></div></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            });
            userLocationMarker = L.marker(latLng, {
                icon: icon,
                zIndexOffset: 800,
                interactive: false,
            }).addTo(map);
        }
        if (center) {
            map.setView(latLng, Math.max(map.getZoom(), 8), { animate: true });
        }
    });
};

window.clearUserLocation = function() {
    if (userLocationMarker) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
};

// Обработчик кнопки определения местоположения: основной путь — через
// нативный мост (FusedLocationProvider), fallback — браузерная геолокация.
function requestUserLocation() {
    if (window.AndroidBridge && typeof window.AndroidBridge.onLocateButtonTapped === 'function') {
        window.AndroidBridge.onLocateButtonTapped();
    } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(position) {
            window.setUserLocation(position.coords.latitude, position.coords.longitude, true);
        });
    }
}
