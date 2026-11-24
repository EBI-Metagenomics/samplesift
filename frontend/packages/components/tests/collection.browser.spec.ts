import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';
import type { SampleSift } from '../src/components/sample-sift';
import type { CollectionQuery, CollectionSearchState, CqlExpression } from '../src/collection/types';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

const ops = ['=', '<>', 'in', 'isNull', '>', '>=', '<', '<='];
const field = (type: string, extra = {}) => ({ type, 'x-samplesift': { operators: ops }, ...extra });
const queryables = { type: 'object', additionalProperties: false, properties: {
  depth: field('number'), date: field('string', { format: 'date' }), updated_at: field('string', { format: 'date-time' }),
  name: field('string', { 'x-samplesift': { operators: ['=', '<>', 'in', 'isNull'] } }),
  temperature: field('number'), geometry: field('object', { 'x-samplesift': { operators: ['s_intersects'] } }),
} };
const openapi = { openapi: '3.2.1', paths: { '/samplesift/collections/occurrences/results': { query: {
  requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
    filter: { type: 'object' }, sort: { type: 'array', items: { type: 'string', enum: ['depth', '-depth', 'date', '-date', 'name', '-name'] } },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, offset: { type: 'integer', minimum: 0 },
  } } } } },
  responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: {
    type: 'object', properties: { source_pk: { type: 'string' }, geometry: { type: ['object', 'null'] }, depth: { type: 'number' }, date: { type: 'string' }, name: { type: 'string' }, temperature: { type: 'number' } },
  } } } } } } } },
} } } };
const rows = [10, 50, 100, 150, 200, 250].map((depth, i) => ({
  source_pk: String.fromCharCode(65 + i), updated_at: `202${i}-01-01T12:00:00Z`, depth, name: `Record ${i}`, date: `202${i}-01-01`, temperature: i * 10,
  geometry: { type: 'Point' as const, coordinates: [i, i] },
}));
const tile = readFileSync(new URL('./fixtures/collection.mvt', import.meta.url));
function matches(item: (typeof rows)[number], expression?: CqlExpression): boolean {
  if (!expression) return true;
  const { op, args } = expression;
  if (op === 'and') return args.every(arg => matches(item, arg as CqlExpression));
  if (op === 's_intersects') return booleanPointInPolygon(item.geometry, args[1] as Polygon);
  const actual = item[(args[0] as { property: keyof typeof item }).property] as string | number;
  const raw = args[1];
  const value = (raw && typeof raw === 'object' && 'date' in raw ? raw.date : raw && typeof raw === 'object' && 'timestamp' in raw ? raw.timestamp : raw) as string | number;
  switch (op) {
    case '=': return actual === value;
    case '<>': return actual !== value;
    case '>': return actual > value;
    case '>=': return actual >= value;
    case '<': return actual < value;
    case '<=': return actual <= value;
    case 'isNull': return actual === null;
    case 'in': return (raw as unknown[]).includes(actual);
    default: throw new Error(`Unhandled fixture operator: ${op}`);
  }
}
async function mockApi(page: Page, cap?: number) {
  const queries: CollectionQuery[] = [], tiles: CollectionQuery[] = [];
  await page.route(/\/samplesift\/(?:openapi\.json|collections\/)/, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/openapi.json')) return route.fulfill({ json: openapi });
    if (path.endsWith('/queryables')) return route.fulfill({ json: queryables });
    expect(request.method()).toBe('QUERY');
    const query = request.postDataJSON() as CollectionQuery;
    if (path.includes('/tiles/')) {
      tiles.push(query);
      return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: tile });
    }
    queries.push(query);
    const filtered = rows.filter(item => matches(item, query.filter));
    const sort = query.sort?.[0];
    if (sort) filtered.sort((a, b) => {
      const key = sort.replace(/^-/, '') as 'depth' | 'date' | 'name';
      return (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (sort.startsWith('-') ? -1 : 1);
    });
    const limit = Math.min(query.limit ?? 100, cap ?? 500), offset = query.offset ?? 0;
    return route.fulfill({ json: { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset } });
  });
  await page.addInitScript(() => {
    (window as unknown as { collectionEvents: unknown[] }).collectionEvents = [];
    document.addEventListener('collectionstatechange', event => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.push((event as CustomEvent).detail));
  });
  return { queries, tiles };
}
async function open(page: Page, cap?: number, mode: 'auto' | 'manual' = 'manual') {
  const calls = await mockApi(page, cap);
  await page.goto('/demo/collection.html?tab=results&tag=a&tag=b#/host');
  const first = page.locator('#first'), second = page.locator('#second');
  await expect(first.getByTestId('collection-count')).toHaveText('6 records');
  await expect(second.getByTestId('collection-count')).toHaveText('6 records');
  if (mode === 'manual') await manualMode(first, second);
  else await autoMode(first, second);
  await expect(first.getByRole('button', { name: 'Add filter', exact: true })).toBeVisible();
  return { first, second, ...calls };
}
async function manualMode(...explorers: Locator[]) {
  for (const explorer of explorers) {
    await explorer.evaluate(async (element: SampleSift) => {
      element.filterMode = 'manual';
      await element.updateComplete;
    });
    await expect(explorer.getByRole('button', { name: 'Apply filters', exact: true })).toBeVisible();
  }
}
async function autoMode(...explorers: Locator[]) {
  for (const explorer of explorers) {
    await explorer.evaluate(async (element: SampleSift) => {
      element.filterMode = 'auto';
      await element.updateComplete;
    });
    await expect(explorer.getByRole('button', { name: 'Apply filters', exact: true })).toHaveCount(0);
  }
}
const filterCard = (explorer: Locator, label: string) => explorer.getByRole('group', { name: `${label} filter`, exact: true });
async function addFilter(explorer: Locator, label: string) {
  const card = filterCard(explorer, label);
  if (!(await card.count())) {
    await explorer.getByRole('button', { name: 'Add filter', exact: true }).click();
    await explorer.getByRole('button', { name: `Add ${label} filter`, exact: true }).click();
  }
  await expect(card).toBeVisible();
  return card;
}
async function condition(explorer: Locator, label: string, value: string) {
  const card = await addFilter(explorer, label);
  const control = card.getByLabel('Condition', { exact: true });
  if (!(await control.isVisible())) await card.getByRole('button', { name: `Change ${label} condition`, exact: true }).click();
  await control.selectOption(value);
  return card;
}
async function applyDepth(first: Locator, value: string) {
  const card = await condition(first, 'Depth', '>=');
  await card.getByLabel('Value', { exact: true }).fill(value);
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
}

test('generated filters and tiles share CQL2 while paging and routing remain independent', async ({ page }) => {
  const { first, second, queries, tiles } = await open(page);
  const before = await page.evaluate(() => {
    history.replaceState({ host: 'preserved' }, '');
    return { href: location.href, length: history.length, state: history.state };
  });
  await applyDepth(first, '50');
  await expect(first.getByTestId('collection-count')).toHaveText('5 records');
  await expect(second.getByTestId('collection-count')).toHaveText('6 records');
  expect(queries.at(-1)?.filter).toEqual({ op: '>=', args: [{ property: 'depth' }, 50] });
  await expect.poll(() => tiles.some(query => JSON.stringify(query.filter) === JSON.stringify(queries.at(-1)?.filter))).toBe(true);
  expect(tiles.every(query => !('limit' in query) && !('offset' in query) && !('sort' in query))).toBe(true);
  const filteredTileCalls = tiles.filter(query => query.filter).length;
  await first.getByLabel('Next collection page').click();
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'D');
  expect(queries.at(-1)?.offset).toBe(2);
  expect(tiles.filter(query => query.filter).length).toBe(filteredTileCalls);
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(1);
  expect(await page.evaluate(() => ({ href: location.href, length: history.length, state: history.state }))).toEqual(before);
});

test('new metadata fields appear automatically and invalid drafts never query', async ({ page }) => {
  const { first, queries } = await open(page);
  const temperature = await condition(first, 'Temperature', '>=');
  await temperature.getByLabel('Value', { exact: true }).fill('20');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('4 records');
  expect(queries.at(-1)?.filter).toEqual({ op: '>=', args: [{ property: 'temperature' }, 20] });
  const calls = queries.length;
  const depth = await condition(first, 'Depth', 'range');
  await depth.getByLabel('Minimum', { exact: true }).fill('100');
  await depth.getByLabel('Maximum', { exact: true }).fill('50');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.locator('sample-sift-collection-filter-form').getByRole('alert').filter({ hasText: 'must not exceed' })).toBeVisible();
  expect(queries.length).toBe(calls);
  await expect(first.getByLabel('Next collection page')).toBeEnabled();
  await depth.getByLabel('Maximum', { exact: true }).fill('150');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('2 records');
});

test('dates preserve pre-1900 values and reject invalid calendar dates', async ({ page }) => {
  const { first, queries } = await open(page);
  const date = await condition(first, 'Date', '>=');
  await date.getByRole('textbox', { name: 'Value', exact: true }).fill('1800-02-28');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.filter).toEqual({ op: '>=', args: [{ property: 'date' }, { date: '1800-02-28' }] });
  const calls = queries.length;
  await date.getByRole('textbox', { name: 'Value', exact: true }).fill('2025-02-29');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.locator('sample-sift-collection-filter-form').getByRole('alert').filter({ hasText: 'valid date' })).toBeVisible();
  expect(queries.length).toBe(calls);
  await date.getByRole('textbox', { name: 'Value', exact: true }).fill('2024-02-29');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('1 record');
});

test('polygon and filters restore atomically and silently using advertised geometry', async ({ page }) => {
  const { first, queries } = await open(page);
  await expect(first.getByRole('button', { name: /polygon/i })).toBeEnabled();
  const before = queries.length;
  const selection: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] };
  await first.evaluate((element: SampleSift, selection) => element.setCollectionState({
    predicates: [{ field: 'depth', operator: '>=', value: 100 }], sort: ['-depth'], selection,
  }), selection);
  await expect(first.getByTestId('collection-count')).toHaveText('3 records');
  expect(queries).toHaveLength(before + 1);
  expect(queries.at(-1)?.filter?.op).toBe('and');
  expect(queries.at(-1)?.filter?.args).toContainEqual({ op: 's_intersects', args: [{ property: 'geometry' }, selection] });
  expect(queries.at(-1)?.filter?.args).toContainEqual({ op: '>=', args: [{ property: 'depth' }, 100] });
  await expect(filterCard(first, 'Depth').getByLabel('Minimum', { exact: true })).toHaveValue('100');
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents)).toEqual([]);
});

test('server-capped pages advance by the returned limit without skipping records', async ({ page }) => {
  const { first, queries } = await open(page, 1);
  await expect(first.locator('tbody tr')).toHaveAttribute('data-record-id', 'A');
  await first.getByLabel('Next collection page').click();
  await expect(first.locator('tbody tr')).toHaveAttribute('data-record-id', 'B');
  expect(queries.at(-1)?.offset).toBe(1);
  await first.getByLabel('Previous collection page').click();
  await expect(first.locator('tbody tr')).toHaveAttribute('data-record-id', 'A');
});

test('host URL adapter preserves foreign state and restores two instances on Back/Forward', async ({ page }) => {
  await mockApi(page);
  await page.goto('/demo/collection-url.html?tab=results&tag=a&tag=b#host');
  const left = page.locator('#left'), right = page.locator('#right');
  await expect(left.getByTestId('collection-count')).toHaveText('6 records');
  await expect(right.getByTestId('collection-count')).toHaveText('6 records');
  await manualMode(left, right);
  await page.evaluate(() => history.replaceState({ host: 'keep' }, ''));
  await applyDepth(left, '50');
  await expect(left.getByTestId('collection-count')).toHaveText('5 records');
  await applyDepth(right, '150');
  await expect(right.getByTestId('collection-count')).toHaveText('3 records');
  const url = new URL(page.url());
  expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
  expect(url.searchParams.get('tab')).toBe('results');
  expect(url.hash).toBe('#host');
  expect(url.searchParams.has('sf.left.query')).toBe(true);
  expect(url.searchParams.has('sf.right.query')).toBe(true);
  expect(await page.evaluate(() => history.state)).toEqual({ host: 'keep' });
  await page.goBack();
  await expect(right.getByTestId('collection-count')).toHaveText('6 records');
  await expect(left.getByTestId('collection-count')).toHaveText('5 records');
  await page.goForward();
  await expect(right.getByTestId('collection-count')).toHaveText('3 records');
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(2);
});

test('invalid host URL state pauses that instance before any broad query', async ({ page }) => {
  const { queries } = await mockApi(page);
  const bad: CollectionSearchState = { predicates: [{ field: 'missing', operator: '=', value: 1 }], sort: [], selection: null };
  const params = new URLSearchParams({ 'sf.left.query': JSON.stringify({ v: 1, ...bad }) });
  await page.goto(`/demo/collection-url.html?${params}`);
  await expect(page.locator('#left').getByTestId('collection-count')).toHaveText('Search paused');
  await expect(page.locator('#right').getByTestId('collection-count')).toHaveText('6 records');
  await expect(page.locator('#route-error')).toContainText('missing');
  expect(queries).toHaveLength(1);
});

// Root-tile fixture coordinates are authored at z0; overzoom it when checking
// rendered features so transport tests do not depend on a camera's tile index.
async function configureTileFixture(first: Locator, queries: CollectionQuery[], maxZoom = 0) {
  const before = queries.length;
  await first.evaluate((element: SampleSift, maxZoom) => {
    element.collectionOptions = {
      baseUrl: '/samplesift', collection: 'occurrences',
      tiles: { sourceLayer: 'occurrences', minZoom: 0, maxZoom },
    };
  }, maxZoom);
  await expect.poll(() => queries.length).toBeGreaterThan(before);
  await expect(first.getByTestId('collection-count')).toHaveText('6 records');
  await expect(first.locator('sample-sift-map canvas')).toBeVisible();
  await expect(first.getByTestId('tile-loading')).toHaveCount(0);
}

type TileTestMap = HTMLElement & {
  _map: import('maplibre-gl').Map;
  tileSource: import('../src/collection/tiles').CollectionTileSource;
  selection: Polygon | null;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function depthPredicateValue(query: CollectionQuery): unknown {
  const find = (expression?: CqlExpression): unknown => {
    if (expression?.op === 'and') {
      for (const child of expression.args) {
        const value = find(child as CqlExpression);
        if (value !== undefined) return value;
      }
    }
    if (expression?.op === '>=' && (expression.args[0] as { property?: string })?.property === 'depth') return expression.args[1];
    return undefined;
  };
  return find(query.filter);
}

async function renderedCollectionFeatures(first: Locator) {
  return first.locator('sample-sift-map').evaluate((element: TileTestMap) => element._map.queryRenderedFeatures({
    layers: ['samplesift-sample-points', 'samplesift-collection-clusters'],
  }).length);
}

test('delayed tile errors retry without changing the camera, region, filters or table', async ({ page }) => {
  const { first, second, queries } = await open(page);
  await configureTileFixture(first, queries);
  await configureTileFixture(second, queries);
  const fail = deferred(), recover = deferred();
  let phase: 'fail' | 'recover' = 'fail';
  let targetedRequests = 0;
  await page.route('**/samplesift/collections/occurrences/tiles/**', async route => {
    const query = route.request().postDataJSON() as CollectionQuery;
    if (depthPredicateValue(query) !== 50) return route.fallback();
    targetedRequests++;
    const captured = phase;
    await (captured === 'fail' ? fail.promise : recover.promise);
    await route.fulfill(captured === 'fail'
      ? { status: 503, body: 'Temporary tile failure' }
      : { contentType: 'application/vnd.mapbox-vector-tile', body: tile }).catch(() => {});
  });
  try {
    const selection: Polygon = { type: 'Polygon', coordinates: [[[-1, -1], [3, -1], [3, 3], [-1, 3], [-1, -1]]] };
    await first.evaluate((element: SampleSift, selection) => element.setCollectionState({
      predicates: [{ field: 'depth', operator: '>=', value: 50 }], sort: ['-depth'], selection,
    }), selection);
    await expect(first.getByTestId('collection-count')).toHaveText('3 records');
    await expect.poll(() => targetedRequests).toBeGreaterThan(0);
    await expect(first.getByTestId('tile-loading')).toBeVisible();
    await expect(second.getByTestId('collection-count')).toHaveText('6 records');
    await expect(second.getByTestId('tile-loading')).toHaveCount(0);
    fail.resolve();
    await expect(first.getByTestId('tile-error')).toContainText('HTTP 503');
    await expect(first.getByRole('button', { name: 'Retry map tiles', exact: true })).toBeVisible();
    await expect(second.getByTestId('tile-error')).toHaveCount(0);
    const map = first.locator('sample-sift-map');
    const before = await map.evaluate((element: TileTestMap) => ({
      center: element._map.getCenter().toArray(), zoom: element._map.getZoom(),
      selection: structuredClone(element.selection), body: structuredClone(element.tileSource.body),
    }));
    const tableCalls = queries.length;
    phase = 'recover';
    await first.getByRole('button', { name: 'Retry map tiles', exact: true }).click();
    await expect(first.getByTestId('tile-loading')).toBeVisible();
    await expect(first.getByTestId('tile-error')).toHaveCount(0);
    recover.resolve();
    await expect(first.getByTestId('tile-loading')).toHaveCount(0);
    await expect.poll(() => renderedCollectionFeatures(first)).toBeGreaterThan(0);
    expect(await map.evaluate((element: TileTestMap) => ({
      center: element._map.getCenter().toArray(), zoom: element._map.getZoom(),
      selection: structuredClone(element.selection), body: structuredClone(element.tileSource.body),
    }))).toEqual(before);
    expect(queries).toHaveLength(tableCalls);
    await expect(filterCard(first, 'Depth').getByLabel('Minimum', { exact: true })).toHaveValue('50');
    await expect(first.getByLabel('Sort records')).toHaveValue('-depth');
    await expect(first.getByTestId('collection-count')).toHaveText('3 records');
    await expect(second.getByTestId('tile-error')).toHaveCount(0);
  } finally { fail.resolve(); recover.resolve(); }
});

test('zoom fetches higher tile coordinates with the same filter and replaces lower-zoom clusters', async ({ page }) => {
  const { first, queries } = await open(page);
  const zoomRequests: Array<{ z: number; method: string; body: CollectionQuery }> = [];
  // The z0 cluster (7) splits into two clusters (3+3) and one singleton at z3.
  // World positions are [-8,4], [8,4] and [1,-4]; tile coordinates are not reused across zooms.
  const zoomTiles = new Map(['0/0/0', '3/3/3', '3/4/3', '3/4/4'].map(coordinates => [
    coordinates, readFileSync(new URL(`./fixtures/zoom-${coordinates.replaceAll('/', '-')}.mvt`, import.meta.url)),
  ]));
  const renderedCounts = () => first.locator('sample-sift-map').evaluate((element: TileTestMap) =>
    element._map.queryRenderedFeatures({ layers: ['samplesift-sample-points', 'samplesift-collection-clusters'] })
      .map(feature => Number(feature.properties.point_count)).sort((a, b) => a - b));
  await page.route('**/samplesift/collections/occurrences/tiles/**', async route => {
    const request = route.request(), body = request.postDataJSON() as CollectionQuery;
    if (depthPredicateValue(body) !== 50) return route.fallback();
    const coordinates = new URL(request.url()).pathname.split('/tiles/')[1];
    const z = Number(coordinates.split('/')[0]);
    zoomRequests.push({ z, method: request.method(), body });
    if (z >= 3) await new Promise(resolve => setTimeout(resolve, 400));
    return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: zoomTiles.get(coordinates) ?? Buffer.alloc(0) });
  });
  await configureTileFixture(first, queries, 4);
  await first.locator('sample-sift-map').evaluate((element: TileTestMap) => {
    // This fixture has a z0 tile; allow that exact zoom instead of the UI's 0.7 minimum.
    element._map.setMinZoom(0);
    element._map.jumpTo({ center: [0, 0], zoom: 0 });
  });
  await applyDepth(first, '50');
  await expect(first.getByTestId('collection-count')).toHaveText('5 records');
  await expect.poll(() => zoomRequests.some(request => request.z === 0)).toBe(true);
  await expect(first.getByTestId('tile-loading')).toHaveCount(0);
  await expect.poll(renderedCounts).toEqual([7]);
  const tableCalls = queries.length;
  await first.locator('sample-sift-map').evaluate((element: TileTestMap) => element._map.jumpTo({ center: [0, 0], zoom: 3 }));
  await expect(first.getByTestId('tile-loading')).toContainText('Updating map detail');
  await expect(first.getByTestId('tile-loading')).toContainText('Cluster counts may still reflect the previous view.');
  await expect.poll(() => zoomRequests.some(request => request.z >= 3)).toBe(true);
  await expect(first.getByTestId('tile-loading')).toHaveCount(0);
  await expect.poll(renderedCounts).toEqual([1, 3, 3]);
  expect(queries).toHaveLength(tableCalls);
  expect(zoomRequests.every(request => request.method === 'QUERY')).toBe(true);
  expect(zoomRequests.every(request => JSON.stringify(request.body) === JSON.stringify({
    filter: { op: '>=', args: [{ property: 'depth' }, 50] },
  }))).toBe(true);
  await expect(first.getByTestId('tile-error')).toHaveCount(0);
});

test('superseded tile failures cannot affect new filters or another pending instance', async ({ page }) => {
  const { first, second, queries } = await open(page);
  await configureTileFixture(first, queries);
  await configureTileFixture(second, queries);
  const old = deferred(), other = deferred(), oldFinished = deferred();
  let oldRequests = 0, otherRequests = 0;
  await page.route('**/samplesift/collections/occurrences/tiles/**', async route => {
    const value = depthPredicateValue(route.request().postDataJSON() as CollectionQuery);
    if (value === 50) {
      oldRequests++;
      await old.promise;
      await route.fulfill({ status: 503, body: 'Superseded failure' }).catch(() => {});
      oldFinished.resolve();
      return;
    }
    if (value === 150) {
      otherRequests++;
      await other.promise;
      await route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: tile }).catch(() => {});
      return;
    }
    return route.fallback();
  });
  try {
    await applyDepth(first, '50');
    await applyDepth(second, '150');
    await expect.poll(() => oldRequests).toBeGreaterThan(0);
    await expect.poll(() => otherRequests).toBeGreaterThan(0);
    await expect(first.getByTestId('tile-loading')).toBeVisible();
    await expect(second.getByTestId('tile-loading')).toBeVisible();
    await applyDepth(first, '100');
    await expect(first.getByTestId('collection-count')).toHaveText('4 records');
    await expect(first.getByTestId('tile-loading')).toHaveCount(0);
    await expect(second.getByTestId('tile-loading')).toBeVisible();
    const tableCalls = queries.length;
    old.resolve();
    await oldFinished.promise;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(first.getByTestId('tile-error')).toHaveCount(0);
    await expect(first.getByTestId('tile-loading')).toHaveCount(0);
    await expect(second.getByTestId('tile-loading')).toBeVisible();
    other.resolve();
    await expect(second.getByTestId('tile-loading')).toHaveCount(0);
    await expect(second.getByTestId('tile-error')).toHaveCount(0);
    await expect(second.getByTestId('collection-count')).toHaveText('3 records');
    expect(queries).toHaveLength(tableCalls);
  } finally { old.resolve(); other.resolve(); }
});

test('opt-in auto filtering debounces typing once and preserves text focus and caret after acknowledgement', async ({ page }) => {
  const { first, second, queries } = await open(page, undefined, 'auto');
  await expect(first.getByRole('button', { name: 'Apply filters', exact: true })).toHaveCount(0);
  const before = queries.length;
  const name = await condition(first, 'Name', '=');
  const input = name.getByRole('textbox', { name: 'Value', exact: true });
  await input.fill('R');
  await input.fill('Record');
  await input.fill('Record 1');
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(3, 3));
  expect(queries).toHaveLength(before);
  await expect(first.getByTestId('collection-count')).toContainText('1 record');
  expect(queries).toHaveLength(before + 1);
  expect(queries.at(-1)?.filter).toEqual({ op: '=', args: [{ property: 'name' }, 'Record 1'] });
  await expect(input).toBeFocused();
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([3, 3]);
  await expect(second.getByTestId('collection-count')).toHaveText('6 records');
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(1);
});

test('auto filtering keeps applied results usable while invalid ranges, dates and native numeric drafts stay local', async ({ page }) => {
  const { first, queries } = await open(page, undefined, 'auto');
  const locationBefore = page.url();
  const before = queries.length;
  const depth = await addFilter(first, 'Depth');
  await depth.getByLabel('Minimum', { exact: true }).fill('100');
  await depth.getByLabel('Maximum', { exact: true }).fill('50');
  await page.waitForTimeout(650); // Longer than the public default debounce.
  expect(queries).toHaveLength(before);
  await expect(first.getByTestId('collection-count')).toHaveText('6 records');
  await expect(first.locator('tbody tr')).toHaveCount(2);
  await expect(first.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled();
  await expect(first.getByLabel('Next collection page')).toBeEnabled();
  await depth.getByLabel('Maximum', { exact: true }).fill('150');
  await expect(first.getByTestId('collection-count')).toHaveText('2 records');

  const date = await condition(first, 'Date', '>=');
  const dateInput = date.getByRole('textbox', { name: 'Value', exact: true });
  const validRangeCalls = queries.length;
  await dateInput.fill('2025-02-29');
  await page.waitForTimeout(650);
  expect(queries).toHaveLength(validRangeCalls);
  await expect(first.getByTestId('collection-count')).toHaveText('2 records');
  await dateInput.fill('2020-01-01');
  await expect.poll(() => queries.length).toBe(validRangeCalls + 1);

  const numeric = depth.getByLabel('Minimum', { exact: true });
  const beforeBadInput = queries.length;
  await numeric.fill('');
  await numeric.press('e');
  expect(await numeric.evaluate((element: HTMLInputElement) => element.validity.badInput)).toBe(true);
  await page.waitForTimeout(650);
  expect(queries).toHaveLength(beforeBadInput);
  await expect(first.locator('tbody tr')).toHaveCount(2);
  expect(page.url()).toBe(locationBefore);
  await first.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('6 records');
  expect(queries.at(-1)?.filter).toBeUndefined();
});

test('manual drafts survive map and sort changes; Apply, Discard and removal preserve the search contract', async ({ page }) => {
  const { first, second, queries } = await open(page);
  const beforeTyping = queries.length;
  const depth = await addFilter(first, 'Depth');
  await depth.getByLabel('Minimum', { exact: true }).fill('100');
  await depth.getByLabel('Maximum', { exact: true }).fill('200');
  await page.waitForTimeout(650);
  expect(queries).toHaveLength(beforeTyping);
  await expect(depth.getByLabel('Maximum', { exact: true })).toBeFocused();
  await expect(first.getByTestId('collection-count')).toHaveText('6 records');
  await first.getByLabel('Sort records').selectOption('-depth');
  await expect.poll(() => queries.at(-1)?.sort).toEqual(['-depth']);
  await expect(depth.getByLabel('Minimum', { exact: true })).toHaveValue('100');
  const selection: Polygon = { type: 'Polygon', coordinates: [[[-1, -1], [3.5, -1], [3.5, 3.5], [-1, 3.5], [-1, -1]]] };
  await first.locator('sample-sift-map').evaluate((element, selection) => {
    element.dispatchEvent(new CustomEvent('selectionchange', { detail: { geometry: selection }, bubbles: true, composed: true }));
  }, selection);
  await expect(first.getByTestId('collection-count')).toHaveText('4 records');
  await expect(depth.getByLabel('Maximum', { exact: true })).toHaveValue('200');
  expect(queries.at(-1)?.filter).toEqual({ op: 's_intersects', args: [{ property: 'geometry' }, selection] });
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('2 records');
  const applied = await first.evaluate((element: SampleSift) => element.collectionState);
  expect(applied.predicates).toEqual([
    { field: 'depth', operator: '>=', value: 100 },
    { field: 'depth', operator: '<=', value: 200 },
  ]);
  expect(applied.sort).toEqual(['-depth']);
  expect(applied.selection).toEqual(selection);

  const beforeDiscard = queries.length;
  await depth.getByLabel('Minimum', { exact: true }).fill('125');
  await first.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(depth.getByLabel('Minimum', { exact: true })).toHaveValue('100');
  expect(queries).toHaveLength(beforeDiscard);
  const name = await condition(first, 'Name', '=');
  await name.getByRole('textbox', { name: 'Value', exact: true }).fill('Record 2');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toContainText('1 record');
  const beforeRemoval = queries.length;
  await depth.getByRole('button', { name: 'Remove Depth filter', exact: true }).click();
  await expect(depth).toHaveCount(0);
  expect(queries).toHaveLength(beforeRemoval);
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => first.evaluate((element: SampleSift) => element.collectionState.predicates)).toEqual([
    { field: 'name', operator: '=', value: 'Record 2' },
  ]);
  await expect.poll(() => queries.length).toBe(beforeRemoval + 1);
  await first.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('4 records');
  const cleared = await first.evaluate((element: SampleSift) => element.collectionState);
  expect(cleared.predicates).toEqual([]);
  expect(cleared.sort).toEqual(['-depth']);
  expect(cleared.selection).toEqual(selection);
  await expect(second.getByTestId('collection-count')).toHaveText('6 records');
});

test('Back cancels an uncommitted auto-filter timer even when that widget’s applied URL state is unchanged', async ({ page }) => {
  await mockApi(page);
  await page.goto('/demo/collection-url.html?tab=results&tag=a&tag=b#host');
  const left = page.locator('#left'), right = page.locator('#right');
  await expect(left.getByTestId('collection-count')).toHaveText('6 records');
  await expect(right.getByTestId('collection-count')).toHaveText('6 records');
  await autoMode(left, right);
  await page.evaluate(() => history.replaceState({ host: 'keep-auto' }, ''));
  const leftDepth = await condition(left, 'Depth', '>=');
  await leftDepth.getByLabel('Value', { exact: true }).fill('50');
  await expect(left.getByTestId('collection-count')).toHaveText('5 records');
  const rightName = await condition(right, 'Name', '=');
  await rightName.getByRole('textbox', { name: 'Value', exact: true }).fill('Record 3');
  await expect(right.getByTestId('collection-count')).toContainText('1 record');
  await leftDepth.getByLabel('Value', { exact: true }).fill('100');
  await page.goBack();
  await expect(right.getByTestId('collection-count')).toHaveText('6 records');
  await expect(leftDepth.getByLabel('Minimum', { exact: true })).toHaveValue('50');
  await page.waitForTimeout(650);
  await expect(left.getByTestId('collection-count')).toHaveText('5 records');
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(2);
  const url = new URL(page.url());
  expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
  expect(url.searchParams.get('tab')).toBe('results');
  expect(url.hash).toBe('#host');
  expect(url.searchParams.has('sf.left.query')).toBe(true);
  expect(url.searchParams.has('sf.right.query')).toBe(false);
  expect(await page.evaluate(() => history.state)).toEqual({ host: 'keep-auto' });
  await page.goForward();
  await expect(right.getByTestId('collection-count')).toContainText('1 record');
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(2);
});

test('failed updates and retries retain the last successful table with an explicit previous-results message', async ({ page }) => {
  const { first, second } = await open(page);
  await first.getByLabel('Next collection page').click();
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'C');
  const failure = deferred();
  const attempts: CollectionQuery[] = [];
  let phase: 'fail' | 'recover' = 'fail';
  let failedRequests = 0;
  await page.route('**/samplesift/collections/occurrences/results', async route => {
    const query = route.request().postDataJSON() as CollectionQuery;
    if (depthPredicateValue(query) !== 50) return route.fallback();
    attempts.push(query);
    if (phase === 'recover') return route.fallback();
    failedRequests++;
    await failure.promise;
    await route.fulfill({ status: 503, json: { detail: 'Temporary collection outage' } }).catch(() => {});
  });
  try {
    await applyDepth(first, '50');
    await expect.poll(() => failedRequests).toBe(1);
    await expect(first.getByText('Updating…', { exact: true })).toBeVisible();
    await expect(first.getByTestId('collection-count')).toHaveText('6 records');
    await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'C');
    failure.resolve();
    const error = first.getByRole('alert').filter({ hasText: 'HTTP 503' });
    await expect(error).toContainText('previous results are still shown');
    await expect(first.locator('tbody tr')).toHaveCount(2);
    await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'C');
    await expect(second.getByTestId('collection-count')).toHaveText('6 records');
    await expect(first.getByLabel('Previous collection page')).toBeDisabled();
    await expect(first.getByLabel('Next collection page')).toBeDisabled();
    phase = 'recover';
    await first.getByRole('button', { name: 'Retry search', exact: true }).click();
    await expect(first.getByTestId('collection-count')).toHaveText('5 records');
    await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'B');
    await expect(error).toHaveCount(0);
    expect(attempts.map(query => query.offset)).toEqual([0, 0]);
    expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(1);
  } finally { failure.resolve(); }
});


test('saved conditions outside the simple editor stay applied until their card is explicitly removed', async ({ page }) => {
  const { first, queries } = await open(page);
  await first.evaluate((element: SampleSift) => element.setCollectionState({
    predicates: [
      { field: 'depth', operator: '>', value: 10 },
      { field: 'depth', operator: '<', value: 50 },
      { field: 'name', operator: '<>', value: 'Record 0' },
    ], sort: [], selection: null,
  }));
  await expect(first.getByTestId('collection-count')).toHaveText('0 records');
  const depth = filterCard(first, 'Depth');
  await expect(depth).toBeVisible();
  await expect(filterCard(first, 'Name')).toBeVisible();
  const before = queries.length;
  await depth.getByRole('button', { name: 'Remove Depth filter', exact: true }).click();
  await expect(depth).toHaveCount(0);
  expect(queries).toHaveLength(before);
  await expect(first.getByTestId('collection-count')).toHaveText('0 records');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(first.getByTestId('collection-count')).toHaveText('5 records');
  expect(queries).toHaveLength(before + 1);
  expect(queries.at(-1)?.filter).toEqual({ op: '<>', args: [{ property: 'name' }, 'Record 0'] });
  expect(await page.evaluate(() => (window as unknown as { collectionEvents: unknown[] }).collectionEvents.length)).toBe(1);
});


test('date-time calendar applies UTC timestamp filters to results and tiles', async ({ page }) => {
  const { first, queries, tiles } = await open(page);
  const card = await condition(first, 'Updated at', '>=');
  const picker = card.locator('gui-date-time-picker:visible');
  await expect(picker).toContainText('UTC');
  await picker.getByRole('button').click();
  await expect(picker.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await picker.getByRole('spinbutton', { name: 'Month', exact: true }).fill('1');
  await picker.getByRole('spinbutton', { name: 'Day', exact: true }).fill('1');
  await picker.getByRole('spinbutton', { name: 'Year', exact: true }).fill('2023');
  await picker.getByRole('spinbutton', { name: 'Hour', exact: true }).fill('12');
  await picker.getByRole('spinbutton', { name: 'Minute', exact: true }).fill('0');
  await picker.getByRole('spinbutton', { name: 'Minute', exact: true }).press('Tab');
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const filter = { op: '>=', args: [{ property: 'updated_at' }, { timestamp: '2023-01-01T12:00:00Z' }] };
  await expect.poll(() => queries.at(-1)?.filter).toEqual(filter);
  await expect(first.getByTestId('collection-count')).toHaveText('3 records');
  await expect.poll(() => tiles.some(query => JSON.stringify(query.filter) === JSON.stringify(filter))).toBe(true);
});
