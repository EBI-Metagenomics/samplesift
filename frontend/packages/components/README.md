# SampleSift components

`<sample-sift>` is a reusable browser explorer built with Lit, MapLibre GL JS, and Terra Draw. It combines rectangle/polygon selection, assembly contig N50 and taxonomy filters, optional biome/date controls, a distinct-sample count, and a paginated table. `<sample-sift-map>` supplies the map alone.

This is a frontend prototype. Explicit `demo` mode uses **synthetic samples, assembly metrics, and taxonomic annotations**. A real MGnify backend is not included, and the API below remains a proposed SampleSift contract.

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

The development server exposes the main synthetic demo, `/demo/contract.html` with two independent components, and `/demo/url-state.html` with host-managed URL state for `left` and `right` instances. The latter's integration code is in [demo/url-state.ts](demo/url-state.ts).

`npm run build` checks TypeScript and writes ES modules, declarations, and worker assets to `packages/components/dist/`. Run `npm run preview` and open `/embed.html` to inspect a plain HTML consumer of the build.

## Embed

Serve the complete `dist/` directory over HTTP, preserving its relative file layout:

```html
<script type="module" src="/sample-sift/sample-sift.js"></script>
<sample-sift demo page-size="25"></sample-sift>
```

Both custom elements register on import. Their styles are contained in Shadow DOM; keep the emitted JavaScript chunks and worker assets together. Browser DOM and WebGL support are required; server-side rendering is outside this prototype's scope.

A bundler-based host can install the local workspace package and import `@samplesift/components`. This repository does not imply that the package has been published to a registry.

For a backend that implements the query transport described below:

```html
<sample-sift api-url="https://samples.example.org/api" page-size="25"></sample-sift>
```

Without `demo`, `api-url`, or a `dataSource` property, the component shows setup guidance. An explicitly assigned `dataSource` takes precedence over `api-url` and `demo`. A remote API must allow requests from the host page's origin.

## Configure the controls and filters

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

## Assembly evidence and matching semantics

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

For an application router, perform the same read/patch/restore steps through its navigation API instead of calling `history` directly. Remove host listeners when disposing the integration. See `/demo/url-state.html` and [its source](demo/url-state.ts) for two synthetic instances with independent namespaces.

## Methods and events

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
map.fitSamples(); // Fit only the current sample page.
map.selectSample('SAMPLE-001'); // Highlight without searching.
map.addEventListener('selectionchange', event => console.log(event.detail.geometry));
map.addEventListener('sampleclick', event => console.log(event.detail.sample));
```

## Limits

The implementation supports these four filter groups, local taxonomy suggestions, pure URL helpers, reusable components, and synthetic demonstration data. It does not include a live MGnify import/backend, remote taxonomy autocomplete or lineage resolution, freehand drawing, a sample vector-tile service, PGlite, or a verified 100k-record performance result. MapLibre replaces the earlier Leaflet proposal. Dependency licenses remain their own; a project license has not yet been selected for this prototype.
