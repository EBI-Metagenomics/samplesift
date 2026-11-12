# SampleSift components

Embeddable web components for exploring SampleSift collections, with a reusable
standalone map. Built with Lit and MapLibre, they work in React, Django templates
and other browser applications. CSS variables and named parts let the host theme
them without replacing the default design.

The complete explorer connects to a compatible **collection API** for filter
metadata, result pages and clustered map tiles. The npm package supplies the UI;
it does not install the Python backend or include a biological dataset. You can
connect to an API someone already operates. The Python SampleSift package provides
that API, and another implementation can follow the same
[collection contract](COLLECTION_API.md#api-compatibility).

Python releases also bundle the frontend for Django's `{% samplesift %}` template
tag, so Django users can use that route without npm. The npm package is for hosts
that manage their own frontend assets. The two packages have independent versions;
compatibility follows the collection API contract.

The standalone `<sample-sift-map>` works with points supplied by your application
and does not need a SampleSift API.

## Install

In an existing application with a JavaScript bundler:

```sh
npm install @samplesift/components
```

Use Node.js 22.12 or newer for the package tooling. Import the package from your
**browser entry point** to register its custom elements:

```js
import '@samplesift/components';
```

For server-rendered applications, load this import only on the client. The
separate `@samplesift/components/data` entry contains helpers that can be imported
without a browser DOM. The browser components need WebGL support.

## Connect to an existing API

After the browser import, add this to your page or React JSX:

```html
<sample-sift
  api-url="/samplesift"
  collection="occurrences"
  tile-layer="occurrences"
></sample-sift>
```

Replace the collection and tile layer with names provided by your API. `api-url`
is the API root, including its mount path; it is not an individual results URL.
The host must route `/samplesift` to the running API, or use a separate origin
that permits CORS requests with the `QUERY` method. npm installation does not set
up that routing. See [API compatibility](COLLECTION_API.md#api-compatibility).

The default is a compact map with collapsible filters and an explicit **Apply
filters** button. Add `show-table` to enable a Results panel. Add `layout="full"`
for the expanded layout; the table remains a separate opt-in. The component does
not change your application's URL or routing.

For React and Django template setup, including static asset deployment, see the
[styling and integration examples](STYLING.md). An
[EBI Visual Framework React example](examples/styling/react-vf/README.md) is also
included in the package.

## Use the map with your own points

This example needs no SampleSift API. Default basemap images still come from the
configured map providers.

Add the element to your HTML:

```html
<sample-sift-map id="sample-map" style="height: 420px"></sample-sift-map>
```

Then run this from the browser entry point after the element exists:

```js
import '@samplesift/components';

const map = document.querySelector('#sample-map');
map.samples = [{
  accession: 'EXAMPLE-001',
  title: 'Example marine sample',
  longitude: -5.2,
  latitude: 36.1,
  biome: 'Marine',
  collectionDate: null,
}];
map.addEventListener('selectionchange', event => {
  // GeoJSON Polygon, or null when the user clears the selection.
  console.log(event.detail.geometry);
});
```

Point input uses the package's `Sample` format, as shown above. Drawing emits a
selection for your application to handle; it does not fetch or filter records by
itself. Supplied points render as individual markers, without client-side
clustering. No 100k-record performance claim is made for this mode.

For a small local-data demonstration, the original **legacy sample mode** also
accepts `createFixtureDataSource(samples)` or the explicit `demo` attribute. It
uses fixed N50/taxonomy/biome/date filters and scans the loaded array; its map
shows the current result page. This is separate from API-backed collection mode.
The configured collection service is not automatically MGnify data.

## Develop and build

Use Node.js 22.12 or newer. From the repository's `frontend/` directory:

```sh
npm ci
npm run dev
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

If Chrome is already installed, `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` can use it instead of downloading Chromium. These are verification commands, not a claim that they have been run in your environment.

`SAMPLESIFT_API_TARGET` sets the backend origin; the development proxy keeps browser API requests on `/samplesift`. The main `/` demo uses the `occurrences` collection. `/demo/compact.html` shows two independent compact embeds. `/demo/collection-url.html` demonstrates two collection widgets with host-owned URLs. The synthetic legacy demo is at `/demo/legacy.html`; `/demo/contract.html` and `/demo/url-state.html` retain the legacy integration examples. Those synthetic pages also work with plain `npm run dev` and no backend target. See [the proxy guidance](COLLECTION_API.md#development-proxy-and-limits) for production and CORS considerations.

`npm run build` checks TypeScript and writes ES modules, declarations, and worker assets to `packages/components/dist/`. Run `npm run preview` and open `/embed.html` to inspect a plain HTML consumer of the build.

## Collection mode

```html
<script type="module" src="/sample-sift/sample-sift.js"></script>
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" page-size="25"></sample-sift>
```

`api-url` is the API root including `/samplesift`. `collection` opts into collection mode; `tile-layer` explicitly names the source layer inside the MVT. Alternatively, assign `collectionOptions` as a JavaScript property. Advertised `s_intersects` geometry support enables rectangles and polygons; available scalar filters come from metadata rather than hardcoded domain fields.

Filters use a searchable **Add filter** picker with compact field cards, inclusive numeric/date ranges and applied filter chips. Edits remain drafts until **Apply filters**; **Discard changes** restores the applied state. Hosts can opt into debounced updates with `filter-mode="auto"`.

Use `collectionState`, silent `setCollectionState(state)`, `collectionMetadata`, and `collectionPaused` for host integration. Collection events and pure URL helpers are documented in [COLLECTION_API.md](COLLECTION_API.md). The host owns optional URL synchronization. The direct `<sample-sift-collection>` element exposes the same explorer without the legacy wrapper.

## Compact and full layouts

The default is a compact, map-first card with the filters closed and no results table. Open **Filters** to edit the search; collection filters still require **Apply filters**. The map, draft edits and table page are preserved while panels open or close. A summary keeps applied filters and search feedback visible.

The table is a separate host opt-in in both layouts:

```html
<!-- Compact map, with an optional Results panel (initially closed). -->
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" show-table></sample-sift>

<!-- Full layout with a filter sidebar and the table inline. -->
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" layout="full" show-table></sample-sift>
```

`layout` accepts `'compact'` (default) or `'full'`. `showTable` defaults to `false` and maps to the boolean `show-table` attribute. Remove the attribute or assign `element.showTable = false` to disable the table: `show-table="false"` still enables it because the attribute is present. `layout="full"` alone does not enable the table. Hosts migrating from the previous always-expanded display should set both `layout="full"` and `show-table`.

Compact mode is 480px tall by default, with a 360px minimum. Set `--samplesift-compact-height` to size the entire card; its panels scroll internally and adapt to the component's width. `--samplesift-map-height` sizes the map in full layout. Filters and Results open one at a time; Escape or a close button closes the panel and returns focus to its toggle. Layer controls remain on the map.

The same `layout` and `showTable` properties work on `<sample-sift>` and `<sample-sift-collection>`. They affect presentation only. The collection results endpoint is still queried for result counts and state even when the table is disabled; the API has no separate count-only endpoint. Layout choices do not alter filters or host URL state.

## Styling and framework examples

Use CSS variables for the theme and named CSS parts for individual controls. The existing colours and typography remain the defaults in both layouts. See the [styling guide](STYLING.md) for the supported hooks and simple React and Django template examples. For an app using Visual Framework 2, see the [EBI Visual Framework React example](examples/styling/react-vf/README.md).

## Map backgrounds and environmental layers

The **Layers** control offers Standard (OpenStreetMap), Satellite (ESA Sentinel-2 RGB, 2021 composite), and Topographic (OpenTopoMap) backgrounds. **WorldCover 2021** is a separate land-cover overlay with opacity and a class legend. Its colors describe the 2021 map, not the environment on a sample's collection date. These are display layers: showing WorldCover does not add a land-cover search predicate.

Switching these layers keeps the same MapLibre instance, camera, sample layers, highlighting, committed region and unfinished drawing. Only active providers load tiles. Provider loading/error feedback is separate from sample-location tile errors, so a background outage does not disable sample interaction. Provider attribution remains on the map. A provider that fails or takes longer than 15 seconds offers its own retry action; the map-only element also exposes `retryMapLayer(id)`. The composed `maplayererror` event reports `{ id, message }`.

The same `mapLayers` and `mapLayerState` JavaScript properties work on `<sample-sift>`, `<sample-sift-collection>` and `<sample-sift-map>`:

```js
import { defaultMapLayers, normalizeMapLayerState } from '@samplesift/components/data';

const explorer = document.querySelector('sample-sift');
explorer.mapLayers = defaultMapLayers;
const display = normalizeMapLayerState(undefined, defaultMapLayers);
display.basemap = 'satellite';
display.overlays['worldcover-2021'] = { visible: true, opacity: 0.45 };
explorer.mapLayerState = display; // Silent host update; no search or URL mutation.

explorer.addEventListener('maplayerchange', event => {
  // The host may persist event.detail.state in its own application state.
  console.log(event.detail.state);
});
```

The catalog contains `basemaps` and optional `overlays` arrays of `RasterMapLayer`: `id`, `label`, raster `tiles` URL templates, and `attribution` are required. Optional settings include `tileSize`, `minZoom`, `maxZoom`, `description`, `year`, `legend` entries (`label` and six-digit hex `color`), and `resampling` (`linear` or `nearest`). Categorical WorldCover uses nearest-neighbor rendering to avoid blending class colors. Hosts can provide their own XYZ or compatible WMS tile URLs, including their provider's browser API key when needed. The built-in presets do not require accounts or keys. The ESA layers use the public cached MapProxy service used by the WorldCover viewer, with global overviews as well as detailed tiles.

Catalog and state validation helpers are DOM-free. Unknown layer IDs and invalid opacity values are rejected rather than interpreted as search filters. `maplayerchange` bubbles across Shadow DOM once for each user action and supplies `{ state }`; property assignments are silent. Display preferences are excluded from the collection URL/query helpers.

Supplying `mapStyle` without `mapLayers` preserves the existing custom-style behavior and hides the layer control. An explicit catalog opts into managed raster layers above that custom style and below samples and selection. An empty catalog (`{ basemaps: [], overlays: [] }`) disables managed layers and controls. `mapStyle` remains an advanced full-style replacement; use `mapLayerState` for seamless background switching.

Providers retain their own licensing and service policies. See [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/), [ESA WorldCover data and attribution](https://esa-worldcover.org/en/data-access), and [OpenTopoMap usage](https://opentopomap.org/about). The package does not proxy, download or host these datasets. Availability and coverage depend on the configured providers.

## Legacy mode: embed

The following sections describe the original fixed sample contract, used when no collection is configured. Its state, adapters, methods and events remain separate from collection mode.

Serve the complete `dist/` directory over HTTP, preserving its relative file layout:

```html
<script type="module" src="/sample-sift/sample-sift.js"></script>
<sample-sift demo page-size="25"></sample-sift>
```

The custom elements register on import. Their styles are contained in Shadow DOM; keep the emitted JavaScript chunks and worker assets together. Browser DOM and WebGL support are required; server-side rendering is outside this prototype's scope.

A bundler-based host imports `@samplesift/components` as shown in the installation quick start. For release testing before publication, install the generated `.tgz` archive in the consumer application.

For a backend that implements the query transport described below:

```html
<sample-sift api-url="https://samples.example.org/api" page-size="25"></sample-sift>
```

In legacy mode, without `demo`, `api-url`, or a `dataSource` property, the component shows setup guidance. An explicitly assigned `dataSource` takes precedence over `api-url` and `demo`. A remote API must allow requests from the host page's origin.

## Legacy controls and filters

Assign arrays and objects as JavaScript properties:

```js
import '@samplesift/components';
import { EMPTY_FILTERS, normalizeFilters } from '@samplesift/components/data';

await customElements.whenDefined('sample-sift');
const explorer = document.querySelector('sample-sift');

// Default: all four supported groups, in this order.
explorer.filterFields = ['n50', 'taxonomy', 'biome', 'collectionDate'];

// These are suggestions; users may enter another namespaced identifier.
explorer.taxonomyOptions = [
  { id: 'ncbi:2', label: 'Bacteria' },
  { id: 'ncbi:562', label: 'Escherichia coli' },
];
explorer.setFilters(normalizeFilters({ n50MinBp: 50000, taxonId: 'ncbi:2', includeDescendants: true }));

// Clear all filters without changing the selected region.
explorer.setFilters({ ...EMPTY_FILTERS });
```

`FilterField` is the fixed union `'n50' | 'taxonomy' | 'biome' | 'collectionDate'`. To retain the original controls alone, use `['biome', 'collectionDate']`; for assembly-focused embeds, use `['n50', 'taxonomy']`. Hiding a control does not clear its active filter. The component identifies active filters whose controls are hidden, and **Clear filters** resets all groups.

`taxonomyOptions` is a local suggestion list, not a remote autocomplete service or taxonomy resolver. Labels help users choose IDs; filtering uses the namespaced ID, such as `ncbi:562` or `gtdb:RS_GCF_000005845.2`.

`SampleFilters` has seven required fields. `EMPTY_FILTERS` is a frozen default object with `null` values and `includeDescendants: false`; spread it when constructing a mutable object. `normalizeFilters(partial)` fills defaults and validates values. Unsupported filter names, invalid dates, nonpositive/fractional N50 bounds, and inverted ranges are rejected.

Valid user edits commit on the control's `change` event, normally blur for text/number inputs and immediate change for selects/checkboxes. A commit emits `filterschange` with `{ filters }` before the API request succeeds or fails. Invalid drafts show an error and prevent a broader query; they do not emit a valid-filter event.

## Legacy assembly evidence and matching semantics

A sample may include `assemblies: AssemblyEvidence[]`. Each evidence record has a unique accession within that sample, `contigN50Bp: number | null`, and `taxa: TaxonEvidence[]`:

```json
{
  "accession": "SAMPLE-001",
  "title": "Example sample",
  "longitude": -5.2,
  "latitude": 36.1,
  "biome": "Marine",
  "collectionDate": "2024-06-15",
  "assemblies": [
    {
      "accession": "ASSEMBLY-001",
      "contigN50Bp": 50000,
      "taxa": [
        { "id": "ncbi:562", "label": "Escherichia coli", "ancestorIds": ["ncbi:2", "ncbi:561"] }
      ]
    }
  ]
}
```

Contig N50 bounds are **inclusive positive integers in base pairs**. Unknown N50 is excluded only when an N50 bound is active. Taxonomy means a detected taxon in the adapter's declared assembly analysis profile; it does not mean the sample's host organism or automatically the taxon assigned to a genome. Adapters must document their profile/reference source and provenance.

Taxonomy matching is exact by default. With `includeDescendants: true`, an observation also matches when its `ancestorIds` contains the requested ID. Labels are never searched. Missing lineage must be resolved by the backend or adapter; the widget does not guess it.

When N50 and taxonomy are both active, **one AssemblyEvidence record must satisfy both**. A high-N50 assembly with the wrong taxon cannot be combined with a different low-N50 assembly containing the requested taxon. Any qualifying assembly includes its sample once, regardless of how many assemblies or taxa match. Missing assembly/taxon evidence cannot satisfy an active corresponding constraint. Without assembly constraints, samples without assemblies remain eligible.

Spatial, biome, and collection-date filters are ANDed with assembly constraints. Biomes match exactly; date boundaries are inclusive. Unknown dates are excluded while a date constraint is active. Polygon boundaries are included. Normalize real source metadata without inventing exact dates from coarse or missing dates.

## Data adapters and HTTP transport

The `@samplesift/components/data` entry exports adapters, validation/filter helpers, URL helpers, `EMPTY_FILTERS`, and public data types without importing the map component:

```js
import { createFixtureDataSource, createHttpDataSource } from '@samplesift/components/data';

// A caller-provided collection of normalized Sample records.
explorer.dataSource = createFixtureDataSource(samples);

// Recommended explicit transport for a compatible backend.
explorer.dataSource = createHttpDataSource({
  baseUrl: 'https://samples.example.org/api',
  filterTransport: 'query',
  parameterNames: { n50MinBp: 'minimum_contig_n50' }, // Optional fixed-field mapping.
});
```

`api-url` uses **query transport**. The factory `createHttpDataSource()` retains **JSON transport as its default** for compatibility, so select `filterTransport: 'query'` explicitly when needed. `parameterNames` may rename only the seven supported filter fields; names must be valid, unique, and cannot reuse reserved body fields. This mapping does not add arbitrary filter types or change host URL namespaces.

For query transport, the adapter sends `POST {baseUrl}/samples/search` with active filters in the URL:

```text
/api/samples/search?contig_n50_min=50000&taxon_id=ncbi%3A2&include_descendants=true
```

Geometry and pagination remain in the JSON body:

```json
{ "selection": null, "offset": 0, "limit": 25 }
```

Default parameter names are listed below. Null filters and `includeDescendants: false` are omitted; clearing a filter removes its mapped query parameter. Unrelated base-URL query parameters are preserved.

| Filter field | API query name | Host URL key for namespace `left` |
| --- | --- | --- |
| `n50MinBp` | `contig_n50_min` | `sf.left.contig_n50_min` |
| `n50MaxBp` | `contig_n50_max` | `sf.left.contig_n50_max` |
| `taxonId` | `taxon_id` | `sf.left.taxon_id` |
| `includeDescendants` | `include_descendants` | `sf.left.include_descendants` |
| `biome` | `biome` | `sf.left.biome` |
| `dateFrom` | `date_from` | `sf.left.date_from` |
| `dateTo` | `date_to` | `sf.left.date_to` |

JSON transport sends the complete `SearchQuery` in the POST body instead:

```json
{
  "selection": null,
  "filters": {
    "biome": null, "dateFrom": null, "dateTo": null,
    "n50MinBp": 50000, "n50MaxBp": null,
    "taxonId": "ncbi:2", "includeDescendants": true
  },
  "offset": 0,
  "limit": 25
}
```

Both transports expect `SearchResult`: `{ items: Sample[], total: number, facets: { biomes: [{ value: string, count: number }] } }`. Counts describe the complete, fully filtered set of **distinct samples before pagination**. Only the current `items` page is drawn on the map. `collectionDate` may be `null`, `sourceUrl` is optional and must be absolute HTTP(S), and `assemblies` is optional. The included HTTP adapter validates responses.

For a different service, implement `SampleDataSource.search(query, { signal }): Promise<SearchResult>`. Honor cancellation when possible. New requests supersede older responses. The fixture adapter snapshots nested input, requests, and results to prevent caller mutations from affecting later searches.

`selection` is `null` or a GeoJSON `Polygon` in `[longitude, latitude]` order. Supported polygons are closed, simple, single-ring shapes with 3–1000 vertices; holes and antimeridian-crossing edges are rejected. This API is SampleSift's proposed contract, not MGnify's public API. A backend must acquire and normalize MGnify evidence before serving it.

## Optional URL state belongs to the host

Neither custom element reads `window.location`, updates browser history, nor enables URL synchronization by default. The `/data` helpers are pure: they work on supplied `URLSearchParams` and do not access `window`, a router, or history.

- `serializeApiFilters(filters, parameterNames?)` returns unprefixed API parameters.
- `createFilterQueryPatch(filters, { namespace })` returns changes for one instance's seven owned URL keys; `null` means delete.
- `applyFilterQueryPatch(currentParams, patch)` returns a new `URLSearchParams` with those changes applied.
- `readFilterQuery(params, { namespace })` reads that namespace's known keys and fills defaults. Malformed values or duplicate owned keys throw.

Use separate namespaces such as `left` and `right` for multiple widgets. Namespaces accept 1–64 letters, digits, underscores, or hyphens. The patch helper preserves unrelated parameters, future/unknown keys, and duplicate values for unrelated keys. It does not promise byte-for-byte URL preservation: `URLSearchParams` serialization can normalize encoding. Only filters are handled; selection geometry and pagination are not automatically serialized into the host page URL.

The host must apply each patch to its **latest** URL/router state, preserve existing history metadata, and restore filters on back/forward navigation. Invalid URL filters must show an error and prevent searching with silently relaxed defaults. This minimal plain-page example mounts only after a valid restore; an invalid back/forward state detaches the component and aborts its active search:

```html
<p id="url-error" role="alert"></p>
<div id="explorer-slot"></div>
```

```js
import '@samplesift/components';
import {
  createHttpDataSource, readFilterQuery,
  createFilterQueryPatch, applyFilterQueryPatch,
} from '@samplesift/components/data';

const namespace = 'left';
const slot = document.querySelector('#explorer-slot');
const error = document.querySelector('#url-error');
const explorer = document.createElement('sample-sift');
explorer.dataSource = createHttpDataSource({ baseUrl: '/api', filterTransport: 'query' });

function restore() {
  try {
    const filters = readFilterQuery(new URL(location.href).searchParams, { namespace });
    explorer.setSearchState({ filters });
    error.textContent = '';
    if (!explorer.isConnected) slot.append(explorer);
  } catch (cause) {
    explorer.remove();
    error.textContent = cause instanceof Error ? cause.message : 'Invalid URL filters.';
  }
}
explorer.addEventListener('filterschange', (event) => {
  const latest = new URL(location.href);
  const patch = createFilterQueryPatch(event.detail.filters, { namespace });
  latest.search = applyFilterQueryPatch(latest.searchParams, patch).toString();
  history.pushState(history.state, '', latest); // Keep existing history metadata.
});
window.addEventListener('popstate', restore);
restore();
```

For an application router, perform the same read/patch/restore steps through its navigation API instead of calling `history` directly. Remove host listeners when disposing the integration. See `/demo/url-state.html` and [its source](https://github.com/EBI-Metagenomics/samplesift/blob/main/frontend/packages/components/demo/url-state.ts) for two synthetic instances with independent namespaces.

## Legacy methods and events

| Method | Behavior |
| --- | --- |
| `setFilters(partial)` | Validate and merge fields, preserve selection, reset pagination. |
| `setSearchState({ filters?, selection? })` | Validate and apply merged filters and optional geometry atomically, resetting pagination. |
| `setSelection(polygonOrNull)` | Set the region and reset pagination. |
| `clearSelection()` | Remove the region and reset pagination. |
| `refresh()` | Repeat the current query. |

Programmatic setters are silent: they do not emit `filterschange` or `selectionchange`. Pass `null` to clear a nullable filter and `false` to disable descendant matching. `setSearchState()` supports restoring a host-owned search without separate filter/geometry requests.

All public events bubble and cross Shadow DOM:

| Event | Detail and trigger |
| --- | --- |
| `filterschange` | `{ filters }`; valid user commits and Clear filters, before network success. |
| `selectionchange` | `{ geometry }`; user drawing/clearing a region. |
| `resultschange` | `{ query, result }`; successful current search, including programmatic changes. |
| `sampleclick` | `{ accession, sample }`; user selects a map point or table sample. |
| `searcherror` | `{ message }`; current search failure. |

Panning the map does not change the selected region or issue a search. Each component owns its selection, filters, pagination, and requests.

## Map style and map-only use

Set `explorer.mapStyle` to a MapLibre style URL or style object; it is forwarded to the child map. To use a tile-free background:

```js
explorer.mapStyle = {
  version: 8, sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f3' } }],
};
```

Production hosts should choose an appropriate basemap and retain its required attribution. Changing the style does not change the sample data source.

```html
<sample-sift-map id="selection-map" style="height: 420px"></sample-sift-map>
```

```js
const map = document.querySelector('#selection-map');
map.samples = samples;
map.selection = null; // Property assignment is silent.
map.setMode('rectangle'); // 'rectangle', 'polygon', or 'select'
map.fitSamples(); // Fit the supplied samples (the current page when used by the legacy explorer).
map.selectSample('SAMPLE-001'); // Highlight without searching.
map.addEventListener('selectionchange', event => console.log(event.detail.geometry));
map.addEventListener('sampleclick', event => console.log(event.detail.sample));
```

## Limits

Collection mode supports a declared subset of JSON Schema and CQL2, backend result pages and explicitly configured vector tiles; see its [capabilities and limits](COLLECTION_API.md). Legacy mode retains the four fixed filter groups, local taxonomy suggestions and synthetic sample evidence. The frontend does not provide an MGnify importer, remote taxonomy autocomplete or lineage resolution, freehand drawing, PGlite, or a verified 100k-record performance result. MapLibre replaces the earlier Leaflet proposal. The component package is licensed under Apache-2.0; bundled dependencies retain their own licenses (included in `dist/THIRD_PARTY_NOTICES.txt`).
