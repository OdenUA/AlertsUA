/**
 * Загружает и отображает оккупированные территории на карте.
 * Uses the occupiedTerritoriesLayer variable declared in constants.js.
 */
async function loadOccupiedTerritories() {
    console.log('[OccupiedTerritories] Starting to load occupied territories...');

    // Удаляем старый слой если существует
    if (occupiedTerritoriesLayer) {
        console.log('[OccupiedTerritories] Removing old layer');
        map.removeLayer(occupiedTerritoriesLayer);
        occupiedTerritoriesLayer = null;
    }

    let response;
    try {
        response = await fetch(buildUrl('/map/occupied-territories-layer'), {
            headers: {
                'Accept': 'application/json'
            }
        });
    } catch (error) {
        console.error('[OccupiedTerritories] Fetch error:', error);
        // Слой опциональный - продолжаем без него
        return;
    }

    if (!response.ok) {
        console.warn('[OccupiedTerritories] Failed to load:', response.status, response.statusText);
        return;
    }

    const data = await response.json();

    // Проверяем наличие feature
    if (!data.feature) {
        console.warn('[OccupiedTerritories] No feature data received');
        return;
    }

    console.log('[OccupiedTerritories] Feature loaded:', data.feature.type);

    // Определяем тему (светлая/темная)
    var isDark = document.body.classList.contains('dark');

    // Создаем слой с красными границами
    // Используем полупрозрачную красную заливку и красную обводку
    occupiedTerritoriesLayer = L.geoJSON(data.feature, {
        style: function(feature) {
            return {
                // Красная граница
                stroke: true,
                color: '#dc2626',  // Красный цвет (Tailwind red-600)
                weight: 2.5,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',

                // Полупрозрачная красная заливка
                fillColor: '#dc2626',
                fillOpacity: isDark ? 0.15 : 0.1,

                // Не интерактивный - клики проходят сквозь слой
                interactive: false
            };
        }
    }).addTo(map);

    console.log('[OccupiedTerritories] Layer added to map');

    // Обновляем порядок слоев - оккупированные территории должны быть под активными тревогами
    bringAlertLayersToFront();
}

/**
 * Обновляет стиль слоя оккупированных территорий при смене темы
 */
function updateOccupiedTerritoriesTheme() {
    if (!occupiedTerritoriesLayer) {
        return;
    }

    var isDark = document.body.classList.contains('dark');

    occupiedTerritoriesLayer.setStyle({
        fillColor: '#dc2626',
        fillOpacity: isDark ? 0.15 : 0.1
    });
}
