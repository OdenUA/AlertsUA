export const GEOMETRY_CHECK_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://unpkg.com https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://*.tile.opentopomap.org",
  "connect-src 'self'",
  "font-src 'self' data: https://unpkg.com",
].join('; ');

export const GEOMETRY_CHECK_PAGE_HTML = String.raw`<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Перевірка геометрії PostGIS</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      crossorigin=""
    />
    <style>
      :root {
        color-scheme: light;
        --bg: #f2efe8;
        --panel: rgba(255, 250, 242, 0.96);
        --panel-border: rgba(32, 41, 48, 0.14);
        --text: #1e2930;
        --muted: #66757f;
        --map-frame: #ddd4c6;
        --accent: #1d4ed8;
        --accent-soft: rgba(29, 78, 216, 0.12);
        --danger: #b91c1c;
        --missing-bg: rgba(148, 163, 184, 0.14);
        --shadow: 0 18px 48px rgba(35, 33, 28, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        height: 100%;
        background:
          radial-gradient(circle at top left, rgba(250, 204, 21, 0.18), transparent 26%),
          radial-gradient(circle at bottom right, rgba(37, 99, 235, 0.14), transparent 28%),
          var(--bg);
        color: var(--text);
        font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      }

      body {
        min-height: 100vh;
        overflow: hidden;
      }

      .page {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 420px;
        height: 100vh;
        overflow: hidden;
      }

      .map-shell {
        position: relative;
        height: 100vh;
        padding: 18px;
        overflow: hidden;
      }

      #map {
        width: 100%;
        height: calc(100vh - 36px);
        border: 1px solid var(--map-frame);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: var(--shadow);
        background: #d7e0d6;
      }

      .map-hud {
        position: absolute;
        top: 32px;
        left: 32px;
        z-index: 500;
        max-width: min(420px, calc(100% - 64px));
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255, 250, 242, 0.92);
        border: 1px solid rgba(30, 41, 48, 0.12);
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
        backdrop-filter: blur(10px);
      }

      .map-hud h1 {
        margin: 0;
        font-size: 20px;
        line-height: 1.15;
      }

      .map-hud p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .sidebar {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 0;
        height: 100vh;
        padding: 18px 18px 18px 0;
      }

      .panel {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        height: 100%;
        min-height: 0;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        box-shadow: var(--shadow);
        overflow: hidden;
        backdrop-filter: blur(14px);
      }

      .panel-header {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 18px 18px 14px;
        border-bottom: 1px solid rgba(30, 41, 48, 0.08);
      }

      .panel-title-row {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
      }

      .panel-title-row h2 {
        margin: 0;
        font-size: 18px;
        line-height: 1.2;
      }

      .panel-title-row span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(30, 41, 48, 0.07);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
      }

      .toolbar-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .toolbar label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .toolbar select,
      .toolbar button {
        min-height: 40px;
        border-radius: 12px;
        border: 1px solid rgba(30, 41, 48, 0.12);
        background: #fff;
        color: var(--text);
        font: inherit;
      }

      .toolbar select {
        padding: 0 12px;
      }

      .toolbar button {
        padding: 0 14px;
        cursor: pointer;
        background: #fdf6ea;
      }

      .toolbar button:hover {
        border-color: rgba(29, 78, 216, 0.3);
        background: #fffaf1;
      }

      .toolbar-actions button {
        flex: 1 1 0;
        min-width: 0;
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      .summary-card {
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(30, 41, 48, 0.05);
      }

      .summary-card strong {
        display: block;
        font-size: 18px;
        line-height: 1;
      }

      .summary-card span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }

      .status {
        min-height: 20px;
        color: var(--muted);
        font-size: 13px;
      }

      .status.is-error {
        color: var(--danger);
      }

      .tree {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 12px 12px 18px;
        overscroll-behavior: contain;
      }

      .tree-node {
        display: block;
      }

      .tree-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-left: calc(var(--depth, 0) * 18px);
      }

      .tree-children {
        display: block;
      }

      .tree-children.is-collapsed {
        display: none;
      }

      .tree-toggle,
      .tree-toggle-spacer {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 28px;
        width: 28px;
        height: 28px;
      }

      .tree-toggle {
        border: 0;
        border-radius: 10px;
        background: rgba(30, 41, 48, 0.06);
        color: var(--muted);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        transition: background-color 120ms ease, color 120ms ease;
      }

      .tree-toggle:hover {
        background: rgba(29, 78, 216, 0.12);
        color: #1d4ed8;
      }

      .tree-toggle.is-collapsed {
        transform: rotate(-90deg);
      }

      .tree-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin: 0;
        padding: 8px 10px;
        border: 0;
        border-radius: 14px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
        transition: background-color 120ms ease, transform 120ms ease, color 120ms ease;
      }

      .tree-item:hover {
        background: rgba(30, 41, 48, 0.06);
      }

      .tree-item.is-selected {
        background: var(--accent-soft);
        color: #113c9b;
      }

      .tree-item.is-missing {
        cursor: default;
        color: #7b8791;
      }

      .tree-item.is-missing:hover {
        background: transparent;
      }

      .tree-item.is-root {
        margin-top: 6px;
      }

      .type-badge,
      .missing-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }

      .type-badge.oblast {
        background: rgba(15, 118, 110, 0.12);
        color: #0f766e;
      }

      .type-badge.city {
        background: rgba(124, 58, 237, 0.12);
        color: #7c3aed;
      }

      .type-badge.raion {
        background: rgba(180, 83, 9, 0.13);
        color: #b45309;
      }

      .type-badge.hromada {
        background: rgba(37, 99, 235, 0.12);
        color: #2563eb;
      }

      .missing-badge {
        margin-left: auto;
        background: var(--missing-bg);
        color: #64748b;
      }

      .tree-label {
        min-width: 0;
        font-size: 14px;
        line-height: 1.3;
      }

      @media (max-width: 1100px) {
        body {
          overflow: auto;
        }

        .page {
          grid-template-columns: 1fr;
          height: auto;
          overflow: visible;
        }

        .map-shell {
          height: auto;
          padding-bottom: 0;
          overflow: visible;
        }

        #map {
          height: 58vh;
        }

        .sidebar {
          height: auto;
          padding: 0 18px 18px;
        }

        .panel {
          height: auto;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="map-shell">
        <div id="map"></div>
        <div class="map-hud">
          <h1>Перевірка геометрії PostGIS</h1>
          <p>
            Клік по області, району або громаді праворуч додає її геометрію на карту.
            Повторний клік прибирає заливку.
          </p>
        </div>
      </section>

      <aside class="sidebar">
        <section class="panel">
          <div class="panel-header">
            <div class="panel-title-row">
              <h2>Ієрархія регіонів</h2>
              <span id="total-count">0</span>
            </div>

            <div class="toolbar">
              <label>
                Підкладка
                <select id="basemap-select"></select>
              </label>
              <div class="toolbar-actions">
                <button type="button" id="expand-all-button">Розгорнути</button>
                <button type="button" id="collapse-all-button">Згорнути</button>
                <button type="button" id="clear-button">Зняти все</button>
              </div>
            </div>

            <div class="summary">
              <div class="summary-card">
                <strong id="selected-count">0</strong>
                <span>Виділено</span>
              </div>
              <div class="summary-card">
                <strong id="geometry-count">0</strong>
                <span>З геометрією</span>
              </div>
              <div class="summary-card">
                <strong id="missing-count">0</strong>
                <span>Без геометрії</span>
              </div>
            </div>

            <div id="status" class="status">Завантаження даних...</div>
          </div>

          <div id="tree" class="tree"></div>
        </section>
      </aside>
    </div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
    <script>
      const DEFAULT_VIEW = {
        center: [48.65, 31.2],
        zoom: 6,
      };

      const TYPE_LABELS = {
        oblast: 'Область',
        city: 'Місто',
        raion: 'Район',
        hromada: 'Громада',
      };

      const TYPE_ORDER = {
        oblast: 0,
        city: 1,
        raion: 2,
        hromada: 3,
      };

      const TYPE_STYLES = {
        oblast: { color: '#0f766e', fillColor: '#2dd4bf' },
        city: { color: '#7c3aed', fillColor: '#c4b5fd' },
        raion: { color: '#b45309', fillColor: '#fdba74' },
        hromada: { color: '#2563eb', fillColor: '#93c5fd' },
      };

      const featureCache = new Map();
      const activeLayers = new Map();
      const buttonIndex = new Map();
      const branchIndex = new Map();
      const baseLayers = new Map();

      let currentBaseLayer = null;
      let mapInstance = null;
      let totalRegions = 0;
      let regionsWithGeometry = 0;

      const statusElement = document.getElementById('status');
      const treeElement = document.getElementById('tree');
      const basemapSelect = document.getElementById('basemap-select');
      const expandAllButton = document.getElementById('expand-all-button');
      const collapseAllButton = document.getElementById('collapse-all-button');
      const clearButton = document.getElementById('clear-button');

      function resolveMapUrl(pathname) {
        return new URL(pathname, window.location.href);
      }

      function setStatus(message, isError) {
        statusElement.textContent = message || '';
        statusElement.classList.toggle('is-error', Boolean(isError));
      }

      function updateSummary() {
        document.getElementById('total-count').textContent = String(totalRegions);
        document.getElementById('selected-count').textContent = String(activeLayers.size);
        document.getElementById('geometry-count').textContent = String(regionsWithGeometry);
        document.getElementById('missing-count').textContent = String(totalRegions - regionsWithGeometry);
      }

      function setBranchCollapsed(uid, collapsed) {
        const branch = branchIndex.get(uid);
        if (!branch) {
          return;
        }

        branch.children.classList.toggle('is-collapsed', collapsed);
        branch.toggle.classList.toggle('is-collapsed', collapsed);
        branch.toggle.setAttribute('aria-expanded', String(!collapsed));
        branch.toggle.setAttribute('title', collapsed ? 'Розгорнути гілку' : 'Згорнути гілку');
      }

      function setAllBranchesCollapsed(collapsed) {
        for (const uid of branchIndex.keys()) {
          setBranchCollapsed(uid, collapsed);
        }

        setStatus(collapsed ? 'Дерево згорнуто.' : 'Дерево розгорнуто.', false);
      }

      function sortNodes(nodes) {
        nodes.sort((left, right) => {
          const typeDiff = (TYPE_ORDER[left.region_type] ?? 99) - (TYPE_ORDER[right.region_type] ?? 99);
          if (typeDiff !== 0) {
            return typeDiff;
          }

          const titleDiff = left.title_uk.localeCompare(right.title_uk, 'uk');
          if (titleDiff !== 0) {
            return titleDiff;
          }

          return left.uid - right.uid;
        });

        for (const node of nodes) {
          sortNodes(node.children);
        }
      }

      function resolveParentUid(node, nodeMap) {
        if (node.region_type === 'oblast') {
          return null;
        }

        if (node.parent_uid !== null && node.parent_uid !== node.uid && nodeMap.has(node.parent_uid)) {
          return node.parent_uid;
        }

        if (node.region_type === 'hromada') {
          if (node.raion_uid !== null && node.raion_uid !== node.uid && nodeMap.has(node.raion_uid)) {
            return node.raion_uid;
          }

          if (node.oblast_uid !== null && node.oblast_uid !== node.uid && nodeMap.has(node.oblast_uid)) {
            return node.oblast_uid;
          }
        }

        if (node.region_type === 'raion') {
          if (node.oblast_uid !== null && node.oblast_uid !== node.uid && nodeMap.has(node.oblast_uid)) {
            return node.oblast_uid;
          }
        }

        return null;
      }

      function buildTree(rows) {
        const nodeMap = new Map();
        const roots = [];

        for (const row of rows) {
          nodeMap.set(row.uid, {
            ...row,
            children: [],
          });
        }

        for (const node of nodeMap.values()) {
          const parentUid = resolveParentUid(node, nodeMap);
          if (parentUid !== null && nodeMap.has(parentUid)) {
            nodeMap.get(parentUid).children.push(node);
          } else {
            roots.push(node);
          }
        }

        sortNodes(roots);
        return roots;
      }

      async function fetchJson(url) {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
          },
        });

        const text = await response.text();
        const data = text ? JSON.parse(text) : null;

        if (!response.ok) {
          const message = data && data.error && data.error.message_uk
            ? data.error.message_uk
            : response.status + ' ' + response.statusText;
          throw new Error(message);
        }

        return data;
      }

      function createMap() {
        const map = L.map('map', {
          preferCanvas: true,
          zoomControl: true,
        });

        map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
        return map;
      }

      function addBaseLayers(config) {
        const layers = Array.isArray(config && config.layers) ? config.layers : [];
        for (const layerConfig of layers) {
          const tileLayer = L.tileLayer(layerConfig.url_template, {
            attribution: layerConfig.attribution_uk,
            subdomains: layerConfig.subdomains,
            minZoom: layerConfig.min_zoom,
            maxZoom: layerConfig.max_zoom,
          });

          baseLayers.set(layerConfig.id, {
            definition: layerConfig,
            layer: tileLayer,
          });

          const option = document.createElement('option');
          option.value = layerConfig.id;
          option.textContent = layerConfig.title_uk;
          if (layerConfig.is_default) {
            option.selected = true;
          }
          basemapSelect.appendChild(option);
        }

        const initialId = basemapSelect.value || (layers[0] && layers[0].id);
        setBaseLayer(initialId);
      }

      function setBaseLayer(layerId) {
        if (!baseLayers.has(layerId)) {
          return;
        }

        if (currentBaseLayer) {
          mapInstance.removeLayer(currentBaseLayer);
        }

        currentBaseLayer = baseLayers.get(layerId).layer;
        currentBaseLayer.addTo(mapInstance);
      }

      function createFeatureStyle(regionType) {
        const palette = TYPE_STYLES[regionType] || TYPE_STYLES.hromada;
        return {
          color: palette.color,
          weight: regionType === 'oblast' || regionType === 'city' ? 3 : 2,
          opacity: 0.95,
          fillColor: palette.fillColor,
          fillOpacity: 0.45,
        };
      }

      async function getFeature(uid) {
        if (featureCache.has(uid)) {
          return featureCache.get(uid);
        }

        const url = resolveMapUrl('feature');
        url.searchParams.set('uid', String(uid));
        const payload = await fetchJson(url);
        if (!payload || !payload.feature) {
          throw new Error((payload && payload.note_uk) || 'Геометрію не вдалося завантажити.');
        }

        featureCache.set(uid, payload.feature);
        return payload.feature;
      }

      function clearSelections() {
        for (const layer of activeLayers.values()) {
          mapInstance.removeLayer(layer);
        }
        activeLayers.clear();

        for (const button of buttonIndex.values()) {
          button.classList.remove('is-selected');
        }

        updateSummary();
        setStatus('Усі виділення знято.', false);
      }

      async function toggleRegion(node) {
        if (!node.has_geometry) {
          return;
        }

        const button = buttonIndex.get(node.uid);
        if (!button) {
          return;
        }

        if (activeLayers.has(node.uid)) {
          mapInstance.removeLayer(activeLayers.get(node.uid));
          activeLayers.delete(node.uid);
          button.classList.remove('is-selected');
          updateSummary();
          setStatus('Знято виділення: ' + node.title_uk, false);
          return;
        }

        button.disabled = true;
        try {
          const feature = await getFeature(node.uid);
          const layer = L.geoJSON(feature, {
            style: createFeatureStyle(node.region_type),
          }).addTo(mapInstance);

          activeLayers.set(node.uid, layer);
          button.classList.add('is-selected');
          updateSummary();

          const bounds = layer.getBounds();
          if (bounds && bounds.isValid()) {
            mapInstance.fitBounds(bounds, {
              padding: [28, 28],
              maxZoom: node.region_type === 'oblast' || node.region_type === 'city' ? 8 : 11,
            });
          }

          setStatus('Виділено: ' + node.title_uk, false);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(message, true);
        } finally {
          button.disabled = false;
        }
      }

      function appendTree(nodes, depth, fragment) {
        for (const node of nodes) {
          const wrapper = document.createElement('div');
          wrapper.className = 'tree-node';

          const row = document.createElement('div');
          row.className = 'tree-row';
          row.style.setProperty('--depth', String(depth));

          let childrenContainer = null;
          if (node.children.length > 0) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'tree-toggle';
            toggle.innerHTML = '&#9662;';
            toggle.setAttribute('aria-label', 'Згорнути або розгорнути гілку');

            childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';

            toggle.addEventListener('click', function () {
              const isCollapsed = childrenContainer.classList.contains('is-collapsed');
              setBranchCollapsed(node.uid, !isCollapsed);
            });

            row.appendChild(toggle);
            branchIndex.set(node.uid, {
              toggle,
              children: childrenContainer,
            });
          } else {
            const spacer = document.createElement('span');
            spacer.className = 'tree-toggle-spacer';
            row.appendChild(spacer);
          }

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'tree-item';
          if (depth === 0) {
            button.classList.add('is-root');
          }
          if (!node.has_geometry) {
            button.classList.add('is-missing');
          }

          const badge = document.createElement('span');
          badge.className = 'type-badge ' + node.region_type;
          badge.textContent = TYPE_LABELS[node.region_type] || node.region_type;

          const label = document.createElement('span');
          label.className = 'tree-label';
          label.textContent = node.title_uk;

          button.appendChild(badge);
          button.appendChild(label);

          if (!node.has_geometry) {
            const missing = document.createElement('span');
            missing.className = 'missing-badge';
            missing.textContent = 'Немає геометрії';
            button.appendChild(missing);
          } else {
            button.addEventListener('click', function () {
              void toggleRegion(node);
            });
          }

          buttonIndex.set(node.uid, button);
          row.appendChild(button);
          wrapper.appendChild(row);

          if (node.children.length > 0) {
            appendTree(node.children, depth + 1, childrenContainer);
            wrapper.appendChild(childrenContainer);
          }

          fragment.appendChild(wrapper);
        }
      }

      async function initialize() {
        mapInstance = createMap();

        basemapSelect.addEventListener('change', function (event) {
          setBaseLayer(event.target.value);
        });

        expandAllButton.addEventListener('click', function () {
          setAllBranchesCollapsed(false);
        });

        collapseAllButton.addEventListener('click', function () {
          setAllBranchesCollapsed(true);
        });

        clearButton.addEventListener('click', clearSelections);

        try {
          const [config, regionsPayload] = await Promise.all([
            fetchJson(resolveMapUrl('config')),
            fetchJson(resolveMapUrl('regions')),
          ]);

          addBaseLayers(config || {});

          const regions = Array.isArray(regionsPayload && regionsPayload.regions)
            ? regionsPayload.regions
            : [];
          totalRegions = regions.length;
          regionsWithGeometry = regions.filter(function (region) {
            return region.has_geometry;
          }).length;
          updateSummary();

          const tree = buildTree(regions);
          const fragment = document.createDocumentFragment();
          branchIndex.clear();
          buttonIndex.clear();
          appendTree(tree, 0, fragment);
          treeElement.replaceChildren(fragment);

          if (regionsPayload && regionsPayload.note_uk) {
            setStatus(regionsPayload.note_uk, true);
          } else {
            setStatus('Дані завантажено. Можна починати перевірку геометрії.', false);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(message, true);
        }
      }

      void initialize();
    </script>
  </body>
</html>`;