# Collection API integration

`<sample-sift>` enters collection mode when given `collection` or `collectionOptions`. It connects the reusable map and a Golem-generated filter form to a SampleSift collection API, discovering capabilities without assuming MGnify-specific fields. The direct `<sample-sift-collection>` element exposes the same collection explorer; the legacy sample adapters remain available when no collection is configured.

## Connect a collection

The main public element supports a concise collection configuration:

```html
<script type="module" src="/sample-sift/sample-sift.js"></script>
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" page-size="25"></sample-sift>
```

For object configuration, assign `collectionOptions`; it takes precedence over the collection attributes. The wrapper and direct element use these corresponding properties and methods:

| `<sample-sift>` collection mode | Direct `<sample-sift-collection>` |
| --- | --- |
| `collectionOptions` | `options` |
| `collectionState` | `state` |
| `collectionPaused` | `paused` |
| `setCollectionState(state)` | `setState(state)` |
| `collectionMetadata` | `metadata` |
| `filterMode` (default `'manual'`) | `filterMode` |
| `filterDebounceMs` (default `500`) | `filterDebounceMs` |
| `mapLayers` | `mapLayers` |
| `mapLayerState` | `mapLayerState` |

Both expose the collection events below. The remaining code examples use the **direct element**. Import the package and assign `options` as a JavaScript property. `baseUrl` is the **API root**, including `/samplesift`; `collection` is an identifier beneath that root.

```html
<sample-sift-collection id="occurrences"></sample-sift-collection>
```

```js
import '@samplesift/components';

const explorer = document.querySelector('#occurrences');
explorer.options = {
  baseUrl: '/samplesift',
  collection: 'occurrences',
  tiles: { sourceLayer: 'occurrences', minZoom: 0, maxZoom: 18 },
};
explorer.pageSize = 25;
```

Omit `tiles` for a table/filter integration without a collection tile layer. `sourceLayer` names the layer **inside the MVT**, which need not equal the collection identifier. The inspected `occurrences` backend uses `occurrences`; other services must configure their own layer name. `mapStyle` accepts a MapLibre style URL or object, as on the existing map component.

The component requests:

| Method | URL relative to the API root | Purpose |
| --- | --- | --- |
| `GET` | `/openapi.json` | Request schema, sorting, pagination limits, result columns. |
| `GET` | `/collections/{collection}/queryables` | Field types, constraints, advertised operators, spatial capability. |
| `QUERY` | `/collections/{collection}/results` | Filtered result page as JSON. |
| `QUERY` | `/collections/{collection}/tiles/{z}/{x}/{y}` | Filtered Mapbox vector tile. |

`QUERY` is the backend's read-only HTTP method; these endpoints are not substituted with POST or GET. Requests with bodies use `Content-Type: application/json`.

## Queryables, Golem, and CQL2

The metadata parser reads primitive number, integer, string, date, and boolean fields. Operators come from each field's `x-samplesift.operators` capability list. The supported scalar subset is `=`, `<>`, `in`, `isNull`, `>`, `>=`, `<`, and `<=`. Unknown operators or unsupported schema constraints produce diagnostics and unavailable controls; they are not silently converted into weaker filters.

The **Add filter** picker searches available fields. Each selected field has a compact Golem-generated card: numbers and dates start with inclusive ranges when supported, text starts with equality, and **Condition** exposes the other advertised operators. Field titles, descriptions, enums and constraints come from metadata. Backend-supplied UI expressions or widget definitions are not executed, and no value suggestions or facet counts are inferred from a result page.

By default, filters remain drafts until **Apply filters** validates and commits them. **Discard changes** restores the applied filters; **Clear filters** explicitly commits an empty predicate list while retaining the selected region. Invalid or incomplete drafts never issue a broader search. Applied filter chips summarize the current query and let users edit or remove a field. Map selection, sorting and pagination continue to operate on the applied predicates without erasing a draft.

The map and table stay visible while a new search loads. A failed result request retains the previous table with a clear error and retry action. Empty results offer ways to remove filters or clear the region.

Hosts that explicitly prefer automatic updates can set `filterMode = 'auto'` (or `filter-mode="auto"`) and optionally `filterDebounceMs` (or `filter-debounce-ms`). Valid edits then commit after that many milliseconds; manual mode is the default on both public elements. Drafts never emit `collectionstatechange` or change host URL state.

The direct element's public state has this shape (use `setCollectionState()` on the wrapper):

```js
const state = {
  predicates: [
    { field: 'depth', operator: '>=', value: 50 },
    { field: 'date', operator: '>=', value: '2000-01-01' },
    { field: 'name', operator: 'in', value: ['Eutrigla gurnardus'] },
  ],
  sort: ['-date'],
  selection: null,
};
explorer.setState(state); // Silent, complete state replacement; resets table pagination.
```

All names, values, and sort entries must satisfy current metadata. Supported declared value constraints include enums/constants, numeric bounds and `multipleOf`, string length/pattern, and valid calendar dates. The compiler combines predicates with CQL2 `and`; date comparisons use canonical `{ "date": "YYYY-MM-DD" }` literals. `in` uses `[propertyReference, valueArray]`, and `isNull` has one property argument with no value. Inclusive form ranges compile to `>=` and/or `<=`. This is a bounded CQL2 subset, not an arbitrary expression editor.

The compact form edits one condition or one inclusive range per field. Valid saved combinations outside that editor remain visible as read-only cards and continue to filter the query; removing one stages its removal without discarding other fields. Low-level `compileCollectionFilter`, `buildCollectionQuery`, `validateCollectionState`, and `createCollectionDataSource` are available from `@samplesift/components/data`.

## Spatial capabilities

Geometry selection is enabled from capabilities, not guessed from field names:

- One object queryable advertising `s_intersects` enables rectangles and polygons. The selected GeoJSON polygon is compiled to `s_intersects` against that exact property.
- Without an advertised geometry field, a host may explicitly configure `spatial: { longitudeField: 'lon', latitudeField: 'lat' }`. Both numeric fields must advertise `>=` and `<=`. This fallback supports only axis-aligned rectangles, compiled into four inclusive coordinate bounds.
- Without either capability, drawing controls are unavailable. Polygon selection is never approximated as a bounding box.

Selections use `[longitude, latitude]` coordinates and closed, simple single-ring polygons with 3–1000 vertices. Holes and antimeridian-crossing edges remain unsupported.

## Table pages and collection tiles

A result request includes the compiled `filter`, optional advertised `sort`, and `limit`/`offset`. Tiles receive **the same filter only**. Table pagination and sorting do not restrict the map to the visible result page or recreate its tile source. Changing filters or the region creates a new tile revision and cancels obsolete requests.

The inspected tile schema uses Point features with `cluster`, `point_count`, and `cluster_id`. Singleton records also expose `source_pk` and their attributes. MVT features have no intrinsic numeric feature ID, so singleton identification and highlighting use `source_pk`.

The separate local backend uses a world-aligned grid for display aggregation: cells halve in width and height at each zoom. Queries include complete cells across tile boundaries, and each centroid belongs to one tile. This replaces the earlier global DBSCAN calculation, whose chains of nearby points could keep the whole collection together and delay tile updates. The frontend requests higher-zoom tiles as the camera zooms; it does not compute or subdivide backend clusters. The example switches to individual records above zoom 14. Other backends may implement different clustering semantics.

Clusters render as larger circles with count labels; clicking one zooms toward it without pretending it is an individual record. Clicking a singleton emits `featureclick` directly from its tile properties, even when that record is not on the current table page. The pinned MapLibre version can render the count labels using local `sans-serif` glyphs when the style has no glyphs URL; the default raster/background-only styles need no remote font endpoint.

`items` are validated as records with a nonempty string `source_pk` and a GeoJSON Point or `null` geometry. Columns are derived from the OpenAPI item schema. `total` is optional: when absent, the UI identifies the number of records on the current page rather than inventing a total. There is no collection facet-count endpoint or facet UI in this contract.

## Map display preferences

Backgrounds and environmental overlays are configured with `mapLayers` and `mapLayerState` on either public explorer or the map-only element. Built-in options include Standard, Satellite (2021 composite), Topographic and a WorldCover 2021 overlay. These display choices leave predicates, pagination, geometry and sample tile requests unchanged; switching backgrounds also preserves a polygon in progress. See the [map layer integration guide](README.md#map-backgrounds-and-environmental-layers) for the catalog, defaults and silent host restoration.

The composed `maplayerchange` event carries `{ state }` for user display actions. It is independent of `collectionstatechange`, and the collection URL helpers deliberately do not store it. Any persistence belongs to the host. A WorldCover layer supplies visual land-cover context and does not classify samples or add filtering capabilities to the backend.

## Metadata readiness and host-owned URLs

The component never reads or writes browser location/history. Pure collection URL helpers store versioned state under one namespaced key, for example `sf.left.query` or `sf.right.query`. This includes predicates, sort, and selection; table pagination is not persisted.

Restoration requires metadata so unknown fields, unavailable operators, and unsupported geometry cannot silently broaden the query. Set `paused = true` **before mounting**, wait for `collectionready`, restore validated state, and unpause only on success:

```html
<p id="collection-url-error" role="alert"></p>
<div id="collection-slot"></div>
```

```js
import '@samplesift/components';
import {
  readCollectionQuery, createCollectionQueryPatch, applyCollectionQueryPatch,
} from '@samplesift/components/data';

const namespace = 'left';
const error = document.querySelector('#collection-url-error');
const explorer = document.createElement('sample-sift-collection');
explorer.paused = true;
explorer.options = {
  baseUrl: '/samplesift', collection: 'occurrences',
  tiles: { sourceLayer: 'occurrences' },
};

function restore() {
  explorer.paused = true;
  const metadata = explorer.metadata;
  if (!metadata) return;
  try {
    const state = readCollectionQuery(new URL(location.href).searchParams, metadata, {
      namespace, spatial: explorer.options.spatial,
    });
    explorer.setState(state);
    error.textContent = '';
    explorer.paused = false;
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : 'Invalid collection URL state.';
    // Remain paused: no result or tile query with relaxed defaults.
  }
}
explorer.addEventListener('collectionready', restore);
explorer.addEventListener('collectionstatechange', (event) => {
  const latest = new URL(location.href);
  latest.search = applyCollectionQueryPatch(
    latest.searchParams,
    createCollectionQueryPatch(event.detail.state, { namespace }),
  ).toString();
  history.pushState(history.state, '', latest);
});
window.addEventListener('popstate', restore);
document.querySelector('#collection-slot').append(explorer);
```

Use each widget's own namespace. Apply patches to the host's **latest** state, preserve router/history metadata, handle back/forward, and remove listeners when disposing the integration. In a router application, use its navigation API instead of calling history directly. Unrelated parameters and their repeated values survive patches, though `URLSearchParams` can normalize their encoding. Duplicate owned keys, malformed payloads, unknown state fields, and unsupported state versions are rejected.

`paused` (or `collectionPaused` on the wrapper) allows metadata discovery while preventing result/tile searches. Changing `options` reloads capabilities; hosts should pause before switching collections when restoring saved state.

Public integration events bubble across Shadow DOM:

| Event | Detail |
| --- | --- |
| `collectionready` | `{ metadata }` after capability loading. |
| `collectionstatechange` | `{ state }` for valid user commits, region changes, and sorting. |
| `collectionresultschange` | `{ state, query, result }` for a successful current page request. |
| `selectionchange` | `{ geometry }` for user region actions. |
| `featureclick` | `{ id, properties, geometry }` for a singleton or selected table record. |
| `searcherror` | `{ message }` for discovery/search failures. |

`setState()` is silent and discards local drafts, including when the applied state is unchanged; changed states reset pagination. Host Back/Forward handlers should always call it so a pending edit cannot overwrite restored state. `refresh()` repeats the current page request. `metadata` returns a snapshot for host validation. While location tiles are fetching or being decoded, the map shows an accessible loading indicator. Network, HTTP, decoding failures, and requests exceeding 60 seconds show a map-specific error with **Retry map tiles**. Retrying reloads the current filtered tile source while preserving the viewport, region, and table page. Tile dispatch waits 150 ms so requests for intermediate zoom levels can be cancelled before reaching the backend. While finer tiles load, MapLibre may retain coarser tiles and the status explains that counts can reflect the previous view. Superseded requests are cancelled silently; failures from one tile are not hidden by another tile succeeding. The map-only element also exposes `retryTiles()`.

## Development proxy and limits

The inspected development backend did not allow a cross-origin browser `QUERY` request: its preflight returned 405 without CORS headers. The Vite development proxy defaults to the local API at `http://127.0.0.1:8002`. Override `SAMPLESIFT_API_TARGET` to use another server origin:

```sh
# From frontend/. Defaults to the local API on port 8002.
npm run dev
```

Keep the component's API root as `/samplesift` so browser requests stay on the development origin. Production hosts need an equivalent same-origin proxy or backend CORS support for `QUERY` and JSON request headers. The development proxy is not a production deployment mechanism.

The current UI uses offset pagination. Although the low-level contract accepts a cursor and can preserve a returned next cursor, the UI does not navigate by cursor. Result totals are optional; facets are unavailable. Authentication management, arbitrary JSON Schema widgets, unrestricted CQL2 expressions, and a verified 100k-record performance baseline are not included. Collection data is whatever the configured backend serves; the `occurrences` endpoint is not presented as MGnify sample/assembly evidence.
