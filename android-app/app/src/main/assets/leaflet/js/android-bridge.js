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

        // Добавляем кастомный контрол зума в левый нижний угол
        removeCustomZoomControls();
        addCustomZoomControls();

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

// Track popup state to prevent bottom sheet from opening when popup is open
// Use window.isThreatPopupOpen so it's accessible from other modules
window.isThreatPopupOpen = false;

map.on('popupopen', function(event) {
    var popup = event.popup;
    var className = popup && popup.options ? popup.options.className : 'none';
    console.log('[Popup] popupopen - className=' + className);

    if (popup && popup.options && popup.options.className &&
        popup.options.className.indexOf('threat-custom-popup') !== -1) {
        window.isThreatPopupOpen = true;
        console.log('[Popup] Threat popup opened, isThreatPopupOpen=' + window.isThreatPopupOpen);
    }
});

map.on('popupclose', function(event) {
    var popup = event.popup;
    var className = popup && popup.options ? popup.options.className : 'none';
    console.log('[Popup] popupclose - className=' + className);

    if (popup && popup.options && popup.options.className &&
        popup.options.className.indexOf('threat-custom-popup') !== -1) {
        window.isThreatPopupOpen = false;
        console.log('[Popup] Threat popup closed, isThreatPopupOpen=' + window.isThreatPopupOpen);
    }
});

// Track if we should suppress the next click event (used when closing popup)
window.suppressNextClick = false;

// Intercept mousedown to check popup state BEFORE Leaflet processes it
map.on('mousedown', function(event) {
    var popup = map._popup;
    var isPopupOpen = popup && popup._map === map;

    if (isPopupOpen) {
        console.log('[MouseDown] Popup is open, setting suppressNextClick=true');
        window.suppressNextClick = true;
        map.closePopup();

        // Stop the mousedown from propagating to prevent click
        L.DomEvent.stopPropagation(event);
        L.DomEvent.preventDefault(event);
        return false;
    }
});

map.on('click', function (event) {
    // If click originated from a popup element, don't open bottom sheet
    var target = event.originalEvent && event.originalEvent.target;
    if (target) {
        var popupElement = target.closest('.leaflet-popup');
        var popupContent = target.closest('.threat-popup-card');
        if (popupElement || popupContent) {
            console.log('[Click] Click was on popup element, ignoring');
            return;
        }
    }

    // If we're suppressing this click (because we closed a popup on mousedown)
    if (window.suppressNextClick) {
        console.log('[Click] Suppressing click because popup was just closed');
        window.suppressNextClick = false;
        L.DomEvent.stopPropagation(event);
        L.DomEvent.preventDefault(event);
        return;
    }

    if (!isInsideUkraine(event.latlng)) { return; }

    // Check if click is within Kyiv city bounds (which is not in oblastBordersLayer)
    // Exact bounds from API: west=30.23, south=50.21, east=30.83, north=50.59
    var isInsideKyivCity = event.latlng &&
        event.latlng.lat >= 50.21 && event.latlng.lat <= 50.59 &&
        event.latlng.lng >= 30.23 && event.latlng.lng <= 30.83;

    console.log('[Click] lat=' + event.latlng.lat + ', lng=' + event.latlng.lng + ', inKyivCity=' + isInsideKyivCity);

    if (isInsideKyivCity) {
        // Use Kyiv oblast center point for selection
        console.log('[Click] Using Kyiv oblast center');
        selectPoint({ lat: 50.45, lng: 30.523 });
    } else {
        selectPoint(event.latlng);
    }
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

// Кастомный контрол зума
let customZoomControls = null;

function removeCustomZoomControls() {
    if (customZoomControls && map) {
        map.removeControl(customZoomControls);
        customZoomControls = null;
    }
}

function addCustomZoomControls() {
    removeCustomZoomControls();

    // Создаем кастомный контрол зума
    class CustomZoomControl extends L.Control {
        constructor(position) {
            super({ position: 'bottomleft' });
        }

        onAdd(map) {
            const container = L.DomUtil.create('div', 'custom-zoom-control');
            container.style.position = 'absolute';
            container.style.bottom = '20px'; // Позиция снизу с учетом кнопок управления
            container.style.left = '15px';  // Позиция слева с учетом рекламного баннера
            container.style.zIndex = '1000';

            // Применяем тему к контейнеру
            const isDark = document.body.classList.contains('dark');
            container.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'rgba(255, 255, 255, 0.9)';
            container.style.padding = '5px';
            container.style.borderRadius = '5px';
            container.style.boxShadow = isDark ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 5px rgba(0,0,0,0.2)';
            container.style.cursor = 'pointer';

            // Кнопка "Zoom In"
            const zoomInButton = L.DomUtil.create('button', '');
            zoomInButton.innerHTML = '+';
            zoomInButton.style.width = '36px';
            zoomInButton.style.height = '36px';
            zoomInButton.style.marginBottom = '5px';
            zoomInButton.style.border = '1px solid ' + (isDark ? '#2a4258' : '#ccc');
            zoomInButton.style.borderRadius = '3px';
            zoomInButton.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'white';
            zoomInButton.style.color = isDark ? '#b8cfda' : '#1c3040';
            zoomInButton.style.fontSize = '20px';
            zoomInButton.style.lineHeight = '30px';
            zoomInButton.onclick = () => map.zoomIn();

            // Кнопка "Zoom Out"
            const zoomOutButton = L.DomUtil.create('button', '');
            zoomOutButton.innerHTML = '-';
            zoomOutButton.style.width = '36px';
            zoomOutButton.style.height = '36px';
            zoomOutButton.style.border = '1px solid ' + (isDark ? '#2a4258' : '#ccc');
            zoomOutButton.style.borderRadius = '3px';
            zoomOutButton.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'white';
            zoomOutButton.style.color = isDark ? '#b8cfda' : '#1c3040';
            zoomOutButton.style.fontSize = '20px';
            zoomOutButton.style.lineHeight = '30px';
            zoomOutButton.onclick = () => map.zoomOut();

            container.appendChild(zoomInButton);
            container.appendChild(zoomOutButton);

            // Prevent click events from zoom buttons from propagating to map
            L.DomEvent.disableClickPropagation(container);

            return container;
        }
    }

    // Добавляем контрол на карту
    customZoomControls = new CustomZoomControl();
    map.addControl(customZoomControls);
}

// Функция для обновления темы кастомных кнопок зума
function updateCustomZoomTheme() {
    if (!customZoomControls || !map) return;

    const container = customZoomControls.getContainer();
    if (!container) return;

    const isDark = document.body.classList.contains('dark');

    // Обновляем контейнер
    container.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'rgba(255, 255, 255, 0.9)';
    container.style.boxShadow = isDark ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 5px rgba(0,0,0,0.2)';

    // Обновляем кнопки
    const buttons = container.querySelectorAll('button');
    buttons.forEach(button => {
        button.style.border = '1px solid ' + (isDark ? '#2a4258' : '#ccc');
        button.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'white';
        button.style.color = isDark ? '#b8cfda' : '#1c3040';
    });
}

// Обработка изменения размеров экрана
window.addEventListener('resize', function() {
    setTimeout(removeCustomZoomControls, 100);
    setTimeout(addCustomZoomControls, 200);
});

// Добавляем обработку переключения темы
window.addEventListener('themechange', function() {
    updateCustomZoomTheme();
});