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