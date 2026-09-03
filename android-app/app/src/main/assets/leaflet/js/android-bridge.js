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
    // Re-initialize using the new static-geometry approach
    // The actual initialization is handled by app.js — just trigger it
    if (typeof initializeMap === 'function') {
        initializeMap();
    }
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

        // Добавляем кастомный контрол зума
        removeCustomZoomControls();
        addCustomZoomControls();

        await loadConfig();
        await loadUkraineMask();

        // Use static geometry + status bundle (optimized path)
        if (typeof renderAllLayers === 'function') {
            await renderAllLayers();
        } else {
            await refreshOverlays();
        }

        mapReady = true;
        renderThreatOverlays();
        mapReadyQueue.forEach(function(fn) { fn(); });
        mapReadyQueue = [];

        // Сигнал нативной стороне: страница полностью инициализирована,
        // можно исполнять очередь исходящих JS-команд
        if (window.AndroidBridge && typeof window.AndroidBridge.onJsReady === 'function') {
            window.AndroidBridge.onJsReady();
        }
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
    debugLog('[Popup] popupopen - className=' + className);

    if (popup && popup.options && popup.options.className &&
        popup.options.className.indexOf('threat-custom-popup') !== -1) {
        window.isThreatPopupOpen = true;
        debugLog('[Popup] Threat popup opened, isThreatPopupOpen=' + window.isThreatPopupOpen);
    }
});

map.on('popupclose', function(event) {
    var popup = event.popup;
    var className = popup && popup.options ? popup.options.className : 'none';
    debugLog('[Popup] popupclose - className=' + className);

    if (popup && popup.options && popup.options.className &&
        popup.options.className.indexOf('threat-custom-popup') !== -1) {
        window.isThreatPopupOpen = false;
        debugLog('[Popup] Threat popup closed, isThreatPopupOpen=' + window.isThreatPopupOpen);
    }
});

// Track if we should suppress the next click event (used when closing popup)
window.suppressNextClick = false;

// Intercept mousedown to check popup state BEFORE Leaflet processes it
map.on('mousedown', function(event) {
    var popup = map._popup;
    var isPopupOpen = popup && popup._map === map;

    if (isPopupOpen) {
        debugLog('[MouseDown] Popup is open, setting suppressNextClick=true');
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
            debugLog('[Click] Click was on popup element, ignoring');
            return;
        }
    }

    // If we're suppressing this click (because we closed a popup on mousedown)
    if (window.suppressNextClick) {
        debugLog('[Click] Suppressing click because popup was just closed');
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

    debugLog('[Click] lat=' + event.latlng.lat + ', lng=' + event.latlng.lng + ', inKyivCity=' + isInsideKyivCity);

    if (isInsideKyivCity) {
        // Use Kyiv oblast center point for selection
        debugLog('[Click] Using Kyiv oblast center');
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

// Auto-refresh timers — могут ставиться на паузу из нативной стороны,
// когда приложение свёрнуто (экономия батареи и трафика).
var statusPollTimerId = null;
var threatPollTimerId = null;

function pollAlertStatuses() {
    if (!mapReady) { return; }
    if (typeof loadStatusBundle === 'function') {
        loadStatusBundle()
            .then(function () {
                if (typeof refreshStatusesFromCache === 'function') refreshStatusesFromCache();
            })
            .catch(function (error) {
                console.warn('Auto-refresh failed:', error);
            });
    } else if (typeof scheduleOverlayRefresh === 'function') {
        scheduleOverlayRefresh();
    }
}

function pollThreatOverlays() {
    if (!mapReady) { return; }
    if (typeof loadThreatOverlays === 'function') {
        loadThreatOverlays().catch(function (error) {
            console.warn('Threat refresh failed:', error);
        });
    }
}

window.pauseAlertsUaPolling = function () {
    if (statusPollTimerId !== null) { clearInterval(statusPollTimerId); statusPollTimerId = null; }
    if (threatPollTimerId !== null) { clearInterval(threatPollTimerId); threatPollTimerId = null; }
};

window.resumeAlertsUaPolling = function () {
    if (statusPollTimerId === null) { statusPollTimerId = setInterval(pollAlertStatuses, 30000); }
    if (threatPollTimerId === null) { threatPollTimerId = setInterval(pollThreatOverlays, 60000); }
    // При возвращении на передний план сразу получаем свежие данные
    pollAlertStatuses();
    pollThreatOverlays();
};

// Auto-refresh alert states every 30 seconds — lightweight: only fetch status bundle (~86KB)
statusPollTimerId = setInterval(pollAlertStatuses, 30000);

// Auto-refresh threat overlays every 60 seconds so expired threats disappear
threatPollTimerId = setInterval(pollThreatOverlays, 60000);

// Кастомный контрол зума
let customZoomControls = null;
// Кастомный контрол определения местоположения (правый нижний угол)
let customLocateControl = null;

function removeCustomZoomControls() {
    if (customZoomControls && map) {
        map.removeControl(customZoomControls);
        customZoomControls = null;
    }
    if (customLocateControl && map) {
        map.removeControl(customLocateControl);
        customLocateControl = null;
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

    // Контрол "Моё местоположение" — отдельная кнопка в правом нижнем углу
    class CustomLocateControl extends L.Control {
        constructor() {
            super({ position: 'bottomright' });
        }

        onAdd(map) {
            const isDark = document.body.classList.contains('dark');
            const container = L.DomUtil.create('div', 'custom-locate-control');
            container.style.position = 'absolute';
            container.style.bottom = '20px';
            container.style.right = '15px';
            container.style.zIndex = '1000';
            container.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'rgba(255, 255, 255, 0.9)';
            container.style.padding = '5px';
            container.style.borderRadius = '5px';
            container.style.boxShadow = isDark ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 5px rgba(0,0,0,0.2)';
            container.style.cursor = 'pointer';

            const locateButton = L.DomUtil.create('button', '');
            locateButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
                '<path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>' +
                '</svg>';
            locateButton.style.width = '36px';
            locateButton.style.height = '36px';
            locateButton.style.border = '1px solid ' + (isDark ? '#2a4258' : '#ccc');
            locateButton.style.borderRadius = '3px';
            locateButton.style.backgroundColor = isDark ? 'rgba(20, 32, 44, 0.94)' : 'white';
            locateButton.style.color = isDark ? '#b8cfda' : '#1c3040';
            locateButton.style.display = 'flex';
            locateButton.style.alignItems = 'center';
            locateButton.style.justifyContent = 'center';
            locateButton.onclick = () => requestUserLocation();

            container.appendChild(locateButton);

            L.DomEvent.disableClickPropagation(container);

            return container;
        }
    }

    // Добавляем контролы на карту
    customZoomControls = new CustomZoomControl();
    map.addControl(customZoomControls);
    customLocateControl = new CustomLocateControl();
    map.addControl(customLocateControl);
}

// Функция для обновления темы кастомных кнопок зума и локации
function updateCustomZoomTheme() {
    if (!map) return;

    const isDark = document.body.classList.contains('dark');

    [customZoomControls, customLocateControl].forEach(control => {
        if (!control) return;
        const container = control.getContainer();
        if (!container) return;

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