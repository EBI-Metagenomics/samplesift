# SampleSift widget

A reusable spatial sample explorer built with Lit, MapLibre GL JS, and Terra Draw. `<sample-sift>` combines a map, rectangle/polygon selection, biome/date filters, a result count, and a paginated sample table. `<sample-sift-map>` is the smaller map-only component.

This is a browser component prototype. The explicit `demo` mode uses **synthetic samples**, not live MGnify records. The HTTP adapter defines a proposed SampleSift API contract; a matching server is not included.

## Run locally

Use Node.js 22.12 or newer and npm:

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Build and check the package with:

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

If Google Chrome is already installed, `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` uses that browser instead of a separately downloaded Chromium.

`npm run build` performs TypeScript checking and creates browser ES modules plus TypeScript declarations in `dist/`. `npm test` runs the data/geometry unit tests. Browser tests exercise independent component instances, filtering/pagination, spatial selection, asynchronous responses, and reconnecting the same element. They use a tile-free map style and deterministic test data.

For a quick check of the built package, run `npm run preview` after building and open `/embed.html` on the printed URL. This is a plain HTML consumer of the distributable, including its worker assets. `/demo/contract.html` on the development server demonstrates two independent components with a tile-free background.

If Google Chrome is already installed, you can run browser tests with `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` instead of downloading Playwright's Chromium build.

## Use in an HTML page

Serve the complete `dist/` directory over HTTP, retaining its relative file layout:

```html
<script type="module" src="/sample-sift/sample-sift.js"></script>

<!-- Explicitly opt in to synthetic demo records. -->
<sample-sift demo page-size="25"></sample-sift>
```

The bundle registers both custom elements and includes their component styles inside Shadow DOM. There is no separate application stylesheet to install. Its ES-module dependencies must remain alongside it in the distributed `dist/` directory.

For a real backend, omit `demo` and provide the API base URL:

```html
<sample-sift api-url="https://samples.example.org/api" page-size="25"></sample-sift>
```

The API must allow requests from the page's origin when hosted elsewhere. Without `demo`, `api-url`, or a `dataSource` property, the explorer displays setup guidance instead of silently showing fixture data.

For a bundler-based application, install this local package and import it:

```js
import '@samplesift/components';
```

This repository is not a claim that `@samplesift/components` has been published to a package registry. The component needs browser DOM and WebGL support; server-side rendering is not part of this prototype.

## Custom data source

Assign JavaScript objects and geometry through properties or methods, rather than stringifying them into HTML attributes:

```js
const explorer = document.querySelector('sample-sift');
await customElements.whenDefined('sample-sift');

explorer.dataSource = {
  async search(query, { signal }) {
    const response = await fetch('/api/samples/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal,
    });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    return response.json();
  },
};
```

Implement the exported `SampleDataSource` interface for other backends. Data adapters are also exposed through the separate `@samplesift/components/data` entry point, so data-only consumers do not need to import the map component.

```js
import { createFixtureDataSource, createHttpDataSource } from '@samplesift/components/data';

// Use your own normalized Sample[] collection locally.
explorer.dataSource = createFixtureDataSource(samples);

// Or use the included HTTP adapter, which validates responses.
explorer.dataSource = createHttpDataSource({ baseUrl: 'https://samples.example.org/api' });
```

Search is triggered when a region or filter changes, or when the result page changes. Map panning is independent of the selected region. Each component instance owns its own selection, filters, and requests. New searches cancel previous requests when supported by the data source, and older responses cannot overwrite newer results.

## Proposed HTTP contract

The HTTP adapter sends `POST {baseUrl}/samples/search` with a JSON `SearchQuery`:

```json
{
  "selection": null,
  "filters": { "biome": null, "dateFrom": null, "dateTo": null },
  "offset": 0,
  "limit": 25
}
```

`selection` is either `null` or a GeoJSON `Polygon` using `[longitude, latitude]` coordinates. `null` means no spatial filter. Filter dates use `YYYY-MM-DD` strings or `null`. Return a `SearchResult`:

```json
{
  "items": [
    {
      "accession": "SAMPLE-001",
      "title": "Example sample",
      "longitude": -5.2,
      "latitude": 36.1,
      "biome": "Marine",
      "collectionDate": "2024-06-15",
      "sourceUrl": "https://example.org/samples/SAMPLE-001"
    }
  ],
  "total": 1,
  "facets": { "biomes": [{ "value": "Marine", "count": 1 }] }
}
```

`items` contains the requested page, while `total` is the count before pagination. `collectionDate` may be `null`; `sourceUrl` is optional. The browser receives and draws the current page of samples, not every matching record. A large total therefore does not imply that all matching locations are displayed.

The fixture adapter combines filters with AND, uses an exact biome match and inclusive date boundaries, and includes points on polygon boundaries. Unknown collection dates match only when no date range is applied. Biome facet counts describe the fully filtered result set before pagination. HTTP backends should use the same semantics. Preserve coarse or missing source dates when normalizing real data; do not invent an exact collection day.

Selections must be closed, simple polygons with one outer ring and 3–1000 vertices. Holes, self-intersections, and antimeridian-crossing edges are rejected in this version.

This contract belongs to SampleSift, not MGnify's public API. A future server or custom adapter must acquire and normalize MGnify metadata before serving this shape.

## Methods, events, and map style

```js
explorer.setFilters({ biome: 'Marine', dateFrom: '2024-01-01' });
explorer.setSelection({
  type: 'Polygon',
  coordinates: [[[-10, 30], [10, 30], [10, 50], [-10, 50], [-10, 30]]],
});
explorer.clearSelection();
explorer.refresh();

explorer.addEventListener('selectionchange', event => {
  console.log(event.detail.geometry); // Polygon or null
});
explorer.addEventListener('resultschange', event => {
  console.log(event.detail.query, event.detail.result);
});
explorer.addEventListener('sampleclick', event => {
  console.log(event.detail.accession, event.detail.sample);
});
explorer.addEventListener('searcherror', event => {
  console.error(event.detail.message);
});
```

All four events bubble and cross the Shadow DOM boundary. `selectionchange` reports user actions from the drawing tools and their Clear button. Programmatic `setSelection()` and `clearSelection()` update the query without emitting `selectionchange`, avoiding host feedback loops. Successful searches still emit `resultschange`. `setFilters()` merges the supplied fields with the current filters; pass `null` to clear an individual field. Selection and filter changes reset pagination.

Set `mapStyle` to a MapLibre style URL or style object. The explorer forwards it to its child map. For a local, tile-free background:

```js
explorer.mapStyle = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f3' } }],
};
```

Production deployments should supply an appropriate basemap and retain its required attribution. Changing a map style does not change the sample data source.

For a host application that owns its filters and results UI, use the map alone:

```html
<sample-sift-map id="selection-map" style="height: 420px"></sample-sift-map>
```

```js
const map = document.querySelector('#selection-map');
await customElements.whenDefined('sample-sift-map');
map.samples = samples;           // Sample[] to draw
map.selection = null;            // Polygon | null; assignment does not emit an event
map.setMode('rectangle');        // 'rectangle', 'polygon', or 'select'
map.fitSamples();                // fit the current sample page
map.selectSample('SAMPLE-001');  // highlight without issuing a search
map.addEventListener('selectionchange', event => console.log(event.detail.geometry));
map.addEventListener('sampleclick', event => console.log(event.detail.sample));
```

## Scope

Implemented here: a reusable browser component, rectangle and click-to-draw polygon selection, biome/date filtering, pagination, a data-source interface, synthetic demonstration data, and a proposed HTTP adapter.

Not included: a Django/PostGIS backend, a real MGnify import, taxonomy filtering, freehand drawing, a sample vector-tile service, PGlite, or a verified 100k-record performance result. The browser map uses MapLibre rather than the earlier Leaflet proposal. Dependency licenses remain their own; a project license has not yet been selected for this prototype.
