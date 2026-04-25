window.configureAlertsUa = function (nextApiBaseUrl) {
    if (!nextApiBaseUrl || typeof nextApiBaseUrl !== 'string') {
        return;
    }

    const normalizedUrl = nextApiBaseUrl.replace(/\/$/, '');
    if (normalizedUrl === apiBaseUrl) {
        refreshLayout();
        return;
    }

    apiBaseUrl = normalizedUrl;
    hasFittedToData = false;
    mapReady = false;
    mapReadyQueue = [];
    ukraineBoundaryGeometry = null;
    if (ukraineMaskLayer) {
        map.removeLayer(ukraineMaskLayer);
        ukraineMaskLayer = null;
    }
    if (specialAlertLayer) {
        map.removeLayer(specialAlertLayer);
        specialAlertLayer = null;
    }
    if (threatOverlayLayer) {
        map.removeLayer(threatOverlayLayer);
        threatOverlayLayer = null;
    }
    initializeMap();
};

window.invalidateAlertsUaMap = function () {
    refreshLayout();
    window.setTimeout(refreshLayout, 120);
    window.setTimeout(refreshLayout, 420);
};

function runWhenReady(fn) {
    if (mapReady) { fn(); } else { mapReadyQueue.push(fn); }
}

async function initializeMap() {
    mapReady = false;
    try {
        refreshLayout();
        await loadConfig();
        await loadUkraineMask();
        await refreshOverlays();
        mapReady = true;
        // Re-render threat overlays after map is ready to ensure correct zoom level
        renderThreatOverlays();
        mapReadyQueue.forEach(function(fn) { fn(); });
        mapReadyQueue = [];
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Не вдалося відкрити мапу.');
    }
}

map.on('click', function (event) {
    if (!isInsideUkraine(event.latlng)) { return; }
    selectPoint(event.latlng);
});

map.on('zoomend', function () {
    if (!mapReady) {
        return;
    }

    refreshAlertMarkers();
    renderThreatOverlays();
    bringAlertLayersToFront();
});

window.addEventListener('resize', refreshLayout);

// Auto-refresh alert states every 30 seconds
setInterval(function () {
    if (!mapReady) { return; }
    refreshOverlays().catch(function (error) {
        console.warn('Auto-refresh failed:', error);
    });
}, 30000);