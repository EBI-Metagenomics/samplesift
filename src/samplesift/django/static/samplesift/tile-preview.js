(() => {
  // Swagger UI does not recognize OpenAPI 3.2's QUERY method. Adapt its private
  // copy of the schema and translate requests back to QUERY on the wire.
  const schemaUrl = new URL(document.currentScript.dataset.schemaUrl, location.href).href;
  const originalFetch = window.fetch.bind(window);
  const operations = [];
  let maplibrePromise;
  let latestPreview;
  let map;

  function matches(template, pathname) {
    const expected = template.split('/');
    const actual = pathname.split('/');
    return expected.length === actual.length && expected.every((part, i) =>
      /^\{[^}]+\}$/.test(part) || part === actual[i]);
  }

  function tileCoordinates(template, pathname) {
    const actual = pathname.split('/');
    const coords = {};
    template.split('/').forEach((part, i) => {
      const name = /^\{([zxy])\}$/.exec(part)?.[1];
      if (name) coords[name] = Number(actual[i]);
    });
    return ['z', 'x', 'y'].every(name => Number.isInteger(coords[name])) ? coords : null;
  }

  function loadMapLibre() {
    if (!maplibrePromise) maplibrePromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css';
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js';
      script.onload = () => resolve(window.maplibregl);
      script.onerror = () => reject(new Error('Could not load the map.'));
      document.head.appendChild(script);
    });
    return maplibrePromise;
  }

  function attachPreview() {
    const blocks = Array.from(document.querySelectorAll('.opblock'));
    for (const block of blocks) {
      const path = block.querySelector('.opblock-summary-path');
      const method = block.querySelector('.opblock-summary-method');
      if (path && method && operations.some(op => op.path === path.textContent.trim()) && method.textContent !== 'QUERY') {
        method.textContent = 'QUERY';
      }
      if (path && operations.some(op => op.path === path.textContent.trim())) {
        const code = block.querySelector('.curl-command pre, .curl-command code');
        if (code) {
          const command = code.textContent.replace(/(-X\s+)(['"]?)POST\2(?=\s|$)/, '$1$2QUERY$2');
          if (command !== code.textContent) code.textContent = command;
        }
      }
    }
    if (!latestPreview) return;
    const opblock = blocks.find(block => {
      const path = block.querySelector('.opblock-summary-path');
      return path && path.textContent.trim() === latestPreview.operation.path;
    });
    const container = opblock?.querySelector('.responses-inner');
    if (!container || latestPreview.element?.isConnected) return;
    const preview = latestPreview;
    const element = document.createElement('div');
    element.style.cssText = 'height:400px;margin:0 0 16px;background:#eee';
    element.setAttribute('aria-label', 'Returned vector tile map');
    container.prepend(element);
    preview.element = element;
    loadMapLibre().then(async maplibre => {
      if (preview !== latestPreview || !element.isConnected) return;
      if (map) { map.remove(); map = undefined; }
      const {z, x, y, bytes, operation} = preview;
      const longitude = n => n / 2 ** z * 360 - 180;
      const latitude = n => Math.atan(Math.sinh(Math.PI * (1 - 2 * n / 2 ** z))) * 180 / Math.PI;
      const bounds = [[longitude(x), latitude(y + 1)], [longitude(x + 1), latitude(y)]];
      const sources = {basemap: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors'}};
      const layers = [{id: 'basemap', type: 'raster', source: 'basemap'}];
      if (bytes.byteLength) {
        const [{VectorTile}, {default: Pbf}] = await Promise.all([
          import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm'),
          import('https://cdn.jsdelivr.net/npm/pbf@3.2.1/+esm'),
        ]);
        if (preview !== latestPreview || !element.isConnected) return;
        const tile = new VectorTile(new Pbf(new Uint8Array(bytes)));
        const layer = tile.layers[operation.layer];
        const features = layer ? Array.from({length: layer.length}, (_, i) => layer.feature(i).toGeoJSON(x, y, z)) : [];
        sources.tile = {type: 'geojson', data: {type: 'FeatureCollection', features}};
        layers.push({id: 'points', type: 'circle', source: 'tile',
          paint: {'circle-radius': ['case', ['==', ['get', 'cluster'], true], 9, 5], 'circle-color': ['case', ['==', ['get', 'cluster'], true], '#d34b28', '#1769aa'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5}});
      }
      const [[west, south], [east, north]] = bounds;
      sources['tile-boundary'] = {type: 'geojson', data: {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}}};
      layers.push({id: 'tile-boundary', type: 'line', source: 'tile-boundary', paint: {'line-color': '#f28c28', 'line-width': 3}});
      map = new maplibre.Map({container: element, style: {version: 8, sources, layers}});
      map.addControl(new maplibre.NavigationControl());
      map.fitBounds(bounds, {padding: 30, duration: 0, maxZoom: 22});
      map.jumpTo({zoom: Math.max(0, z - 1)});
      map.on('error', () => { element.setAttribute('title', 'Map rendering failed.'); });
    }).catch(() => { element.textContent = 'Map unavailable. The original response is shown below.'; });
  }

  new MutationObserver(attachPreview).observe(document.documentElement, {childList: true, subtree: true});
  document.addEventListener('click', event => {
    const button = event.target.closest('.curl-command .copy-to-clipboard');
    const block = button?.closest('.opblock');
    const path = block?.querySelector('.opblock-summary-path')?.textContent.trim();
    const code = block?.querySelector('.curl-command pre, .curl-command code');
    if (!code || !operations.some(op => op.path === path) || !navigator.clipboard?.writeText) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigator.clipboard.writeText(code.textContent.replace(/(-X\s+)(['"]?)POST\2(?=\s|$)/, '$1$2QUERY$2'));
  }, true);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    if (url.href === schemaUrl && method === 'GET') {
      const response = await originalFetch(input, init);
      if (!response.ok) return response;
      const schema = await response.clone().json();
      for (const [path, item] of Object.entries(schema.paths || {})) {
        if (!item.query) continue;
        operations.push({path, layer: item.query.tags?.[0]});
        item.post = item.query;
        delete item.query;
      }
      schema.openapi = '3.1.0';
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(schema), {status: response.status, statusText: response.statusText, headers});
    }
    const operation = url.origin === location.origin && method === 'POST' && operations.find(op => matches(op.path, url.pathname));
    if (!operation) return originalFetch(input, init);
    const response = await originalFetch(input, {...init, method: 'QUERY'});
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const coords = tileCoordinates(operation.path, url.pathname);
    if (response.ok && mediaType === 'application/vnd.mapbox-vector-tile' && coords) {
      const bytes = await response.clone().arrayBuffer();
      latestPreview = {operation, ...coords, bytes};
      attachPreview();
    }
    return response;
  };
})();
