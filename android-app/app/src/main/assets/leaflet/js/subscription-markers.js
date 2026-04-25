window.addSubscriptionMarker = function(lat, lon, markerId) {
    runWhenReady(function() {
        if (subscriptionMarkers[markerId]) {
            map.removeLayer(subscriptionMarkers[markerId]);
        }
        var icon = L.divIcon({
            className: '',
            html: '<div class="sub-marker"></div>',
            iconSize: [28, 36],
            iconAnchor: [14, 36],
        });
        var id = markerId;
        var marker = L.marker([lat, lon], { icon: icon, zIndexOffset: 600 }).addTo(map);
        marker.on('click', function() {
            if (window.AndroidBridge && window.AndroidBridge.onSubscriptionMarkerTapped) {
                window.AndroidBridge.onSubscriptionMarkerTapped(id);
            }
        });
        subscriptionMarkers[id] = marker;
    });
};

window.removeSubscriptionMarker = function(markerId) {
    if (subscriptionMarkers[markerId]) {
        map.removeLayer(subscriptionMarkers[markerId]);
        delete subscriptionMarkers[markerId];
    }
};

window.restoreSubscriptionMarkers = function(markersList) {
    markersList.forEach(function(m) {
        window.addSubscriptionMarker(m.lat, m.lon, m.markerId);
    });
};