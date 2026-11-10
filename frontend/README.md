# SampleSift frontend

A self-contained npm workspace for browser components, with versions and release cycles independent of the Python package.

```text
frontend/
  package.json             Private npm workspace
  package-lock.json        Shared dependency lockfile
  packages/components/    @samplesift/components: Lit + MapLibre + Terra Draw
```

## Develop

Use Node.js 22.12 or newer (CI uses Node.js 24). From the repository root:

```sh
cd frontend
npm ci
npm run dev
```

The demo uses explicitly synthetic samples, assembly N50 metrics, and taxonomic annotations. A matching backend or custom adapter is required for real MGnify data; no live backend or 100k-record performance result is claimed.

The development server provides:

- `/`: the main explorer demo.
- `/demo/contract.html`: two independent components with a tile-free background.
- `/demo/url-state.html`: host-managed filter URLs for separate `left` and `right` instances, including back/forward restoration.

The [component README](packages/components/README.md) documents embedding, data types, matching semantics, transport, and URL integration. The full host URL example is [demo/url-state.ts](packages/components/demo/url-state.ts).

## Filters and integration

`<sample-sift>` defaults to four configurable control groups: `n50`, `taxonomy`, `biome`, and `collectionDate`. `filterFields` selects and orders those groups; the legacy biome/date controls remain available. `taxonomyOptions` supplies local ID/label suggestions while allowing other namespaced IDs. Remote taxonomy autocomplete is not implemented.

N50 bounds are inclusive positive integers in base pairs. N50 and taxonomy must match the **same assembly evidence record**; a sample is counted once even if several assemblies qualify. Taxonomy refers to a detected taxon in the adapter's declared assembly analysis profile. Exact IDs are the default; descendant matching uses supplied `ancestorIds`, so missing lineage must be resolved in the backend rather than guessed. The synthetic fixture demonstrates absent assemblies and unknown N50 as well as matching evidence.

Valid user filter commits emit `filterschange` before the API succeeds. Programmatic `setFilters()` and atomic `setSearchState()` merge validated state, reset pagination, and do not emit user-change events. Use exported `EMPTY_FILTERS` or `normalizeFilters()` when building the full filter object.

The `api-url` shorthand sends filters as query parameters on `POST /samples/search`; polygon geometry and pagination remain in JSON. The `createHttpDataSource()` factory keeps JSON transport as its compatibility default, so pass `filterTransport: 'query'` explicitly for query transport. Fixed-field parameter-name overrides are supported. See the [contract](packages/components/README.md#data-adapters-and-http-transport) for field names and response shape.

URL synchronization is optional and owned by the host. Pure helpers under `@samplesift/components/data` read or patch supplied query parameters without accessing `window` or history. Namespaces isolate instances, for example `sf.left.contig_n50_min` and `sf.right.taxon_id`. Hosts apply patches to their latest router state, preserve unrelated parameters/history metadata, handle back/forward, and show errors for invalid owned URL values instead of issuing broader queries. Unrelated duplicate values survive a patch, although URL encoding can normalize.

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

The build writes `packages/components/dist/`. `npm run preview` serves it; open `/embed.html` for a plain HTML consumer. Keep JavaScript chunks and worker assets together when deploying. Frontend installation and release tooling remain separate from the Python package.
