# SampleSift frontend

An npm workspace for embeddable Lit components, with versions and release cycles independent of the Python package. The main explorer discovers a collection's queryables and OpenAPI metadata, generates filters with Golem, sends CQL2 over HTTP `QUERY`, and displays result pages alongside filtered vector tiles.

## Develop

Use Node.js 22.12 or newer (CI uses Node.js 24). From the repository root:

```sh
cd frontend
npm ci
npm run dev
```

The development proxy defaults to the local API at `http://127.0.0.1:8002`. To use another server, set `SAMPLESIFT_API_TARGET` to its **origin**, without `/samplesift`. The Vite development proxy forwards the browser's same-origin `/samplesift` requests to that backend. The current inspected backend requires this proxy because its cross-origin `QUERY` preflight is not enabled. Production needs an equivalent proxy or suitable backend CORS support.

The separate backend checkout is `~/Code/samplesift-api`. It runs the bundled OBIS example with its own PostGIS volume. Start or stop it from `~/Code/samplesift-api/examples/obis`:

```sh
docker compose -p samplesift-api-local -f compose.yml -f compose.local.yml up --build -d
docker compose -p samplesift-api-local -f compose.yml -f compose.local.yml down
```

The local override binds the API only to `127.0.0.1:8002` (port 8001 is already in use). Stopping preserves the database. API docs are at `http://127.0.0.1:8002/samplesift/docs`; initialization loads 9,900 bundled OBIS occurrences.

The development server provides:

- `/`: the main `occurrences` collection explorer.
- `/demo/collection-url.html`: two collection widgets with host-owned URL state and back/forward restoration.
- `/demo/legacy.html`: synthetic sample/assembly data using the original fixed-filter contract.
- `/demo/contract.html` and `/demo/url-state.html`: the legacy independent-widget and filter-URL examples.

The synthetic examples can also run without a backend. The main collection demo still requires an available API.

## Collection integration

```html
<sample-sift
  api-url="/samplesift"
  collection="occurrences"
  tile-layer="occurrences"
  page-size="25"
></sample-sift>
```

Collection mode reads advertised fields, operators, sorting, pagination limits and result columns. One geometry queryable advertising `s_intersects` enables rectangle/polygon selection. The tile layer is explicitly configured: its name must match the layer inside the backend's MVT.

URL synchronization remains optional and belongs to the host. Pure helpers preserve unrelated query parameters and separate widget namespaces; the component does not access browser routing. See the [collection API guide](packages/components/COLLECTION_API.md) for embedding, capabilities, methods/events and validated URL restoration, and [the host example](packages/components/demo/collection-url.ts) for working integration code.

The [component README](packages/components/README.md) retains the **legacy mode** contract: fixed N50/taxonomy/biome/date filters, `SampleDataSource`, synthetic fixtures and `POST /samples/search`. Those adapters are separate from the collection API. The configured `occurrences` service is not presented as MGnify sample/assembly evidence, and no 100k-record performance result is claimed.

## Check and build

Run from `frontend/`:

```sh
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

If Chrome is installed, `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` can use it instead. These commands describe the verification workflow; consult their current output for results.

The build writes `packages/components/dist/`. Keep JavaScript chunks and worker assets together when deploying. `npm run preview` serves the build; `/embed.html` is a plain HTML legacy consumer. Frontend installation and release tooling remain separate from the Python package.
