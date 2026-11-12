import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import type { SampleSift } from '../src/components/sample-sift';
import type { SampleSiftCollection } from '../src/components/collection-explorer';
import type { CollectionQuery, CqlExpression } from '../src/collection/types';

const mvt = readFileSync(new URL('./fixtures/collection.mvt', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNImFn+HwAFPQJwCzX1rQAAAABJRU5ErkJggg==', 'base64');
const queryables = { type: 'object', properties: {
  depth: { type: 'number', 'x-samplesift': { operators: ['=', '>=', '<='] } },
  geometry: { type: 'object', 'x-samplesift': { operators: ['s_intersects'] } },
} };
const openapi = { openapi: '3.2.1', paths: { '/samplesift/collections/occurrences/results': { query: {
  requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
    filter: { type: 'object' }, sort: { type: 'array', items: { type: 'string', enum: ['depth', '-depth'] } },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, offset: { type: 'integer', minimum: 0 },
  } } } } },
  responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: {
    type: 'object', properties: { source_pk: { type: 'string' }, geometry: { type: ['object', 'null'] }, depth: { type: 'number' } },
  } } } } } } } },
} } } };
const rows = [10, 50, 100, 150, 200, 250].map((depth, i) => ({ source_pk: `COMPACT-${i}`, depth, geometry: { type: 'Point', coordinates: [i, i] } }));
const polygon: Polygon = { type: 'Polygon', coordinates: [[[-5, -5], [10, -5], [10, 10], [-5, 10], [-5, -5]]] };
type TestMap = HTMLElement & {
  _map: MapLibreMap; _draw: TerraDraw; selection: Polygon | null;
  saved?: { map: MapLibreMap; draw: TerraDraw; center: number[]; zoom: number; selection: Polygon | null };
};

function matches(depth: number, filter?: CqlExpression): boolean {
  if (!filter || filter.op === 's_intersects') return true;
  if (filter.op === 'and') return filter.args.every(item => matches(depth, item as CqlExpression));
  if (filter.op === '>=') return depth >= Number(filter.args[1]);
  if (filter.op === '<=') return depth <= Number(filter.args[1]);
  return depth === Number(filter.args[1]);
}

async function open(page: Page) {
  const calls: CollectionQuery[] = [];
  const behavior = { fail: false, hold: false, release: undefined as (() => void) | undefined };
  await page.addInitScript(() => {
    const events: string[] = [];
    (window as unknown as { compactEvents: string[] }).compactEvents = events;
    document.addEventListener('collectionstatechange', event => events.push(event.type));
  });
  await page.route('**/__compact-layer/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route(/\/samplesift\/(?:openapi\.json|collections\/)/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/openapi.json')) return route.fulfill({ json: openapi });
    if (path.endsWith('/queryables')) return route.fulfill({ json: queryables });
    const query = route.request().postDataJSON() as CollectionQuery;
    if (path.includes('/tiles/')) return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: mvt });
    calls.push(query);
    if (behavior.hold) await new Promise<void>(resolve => { behavior.release = resolve; });
    if (behavior.fail) return route.fulfill({ status: 503, json: { detail: 'Temporary search outage' } });
    const items = rows.filter(row => matches(row.depth, query.filter));
    const offset = query.offset ?? 0, limit = query.limit ?? 25;
    return route.fulfill({ json: { items: items.slice(offset, offset + limit), total: items.length, offset, limit } });
  });
  await page.goto('/demo/compact.html?host=preserved&tag=a&tag=b#route');
  const first = page.locator('#first'), second = page.locator('#second');
  for (const explorer of [first, second]) {
    await expect.poll(() => explorer.evaluate((element: SampleSift) => Boolean(element.collectionMetadata))).toBe(true);
    await expect(explorer.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
    await expect(explorer.locator('canvas')).toBeVisible();
    await expect(explorer.locator('[part="compact-toolbar"]')).toContainText('6');
    await expect(explorer.getByTestId('tile-loading')).toHaveCount(0);
  }
  return { first, second, calls, behavior };
}

const filtersToggle = (explorer: Locator) => explorer.getByRole('button', { name: 'Filters', exact: true });
const resultsToggle = (explorer: Locator) => explorer.getByRole('button', { name: 'Results', exact: true });
const filters = (explorer: Locator) => explorer.locator('[data-panel="filters"]');
const results = (explorer: Locator) => explorer.locator('[data-panel="results"]');

async function addDepth(explorer: Locator) {
  await explorer.getByRole('button', { name: 'Add filter', exact: true }).click();
  await explorer.getByRole('button', { name: 'Add Depth filter', exact: true }).click();
  return explorer.getByRole('group', { name: 'Depth filter', exact: true }).getByRole('spinbutton').first();
}

test('compact is the default and a table requires a separate host opt-in', async ({ page }) => {
  const { first, second, calls } = await open(page);
  const shell = first.locator('[part="explorer"]');
  await expect(shell).toHaveCSS('height', '480px');
  await expect(filters(first)).toBeHidden();
  await expect(first.locator('table')).toHaveCount(0);
  await expect(resultsToggle(first)).toHaveCount(0);
  await expect(first.locator('[part="compact-toolbar"]')).toContainText('6');
  const count = calls.length;
  await first.evaluate((element: SampleSift) => { element.showTable = true; });
  await expect(resultsToggle(first)).toBeVisible();
  await expect(results(first)).toBeHidden();
  await resultsToggle(first).click();
  await expect(first.getByTestId('collection-results')).toBeVisible();
  await expect(first.locator('tbody tr')).toHaveCount(2);
  expect(calls.length).toBe(count);
  await expect(second.locator('table')).toHaveCount(0);
  await expect(resultsToggle(second)).toHaveCount(0);
  await first.evaluate((element: SampleSift) => { element.showTable = false; element.layout = 'full'; });
  await expect(filters(first)).toBeVisible();
  await expect(first.locator('table')).toHaveCount(0);
  await first.evaluate((element: SampleSift) => { element.showTable = true; });
  await expect(first.getByTestId('collection-results')).toBeVisible();
  expect(calls.length).toBe(count);
});

test('panels preserve drafts, map identity, selection and table position, with accessible close behavior', async ({ page }) => {
  const { first, second, calls } = await open(page);
  await first.evaluate((element: SampleSift, geometry) => {
    element.showTable = true;
    element.setCollectionState({ predicates: [], sort: [], selection: geometry });
  }, polygon);
  await resultsToggle(first).click();
  await first.getByRole('button', { name: 'Next collection page', exact: true }).click();
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'COMPACT-2');
  await filtersToggle(first).click();
  await expect(results(first)).toBeHidden();
  await expect(filters(first).locator('[data-panel-heading]')).toBeFocused();
  await first.getByRole('button', { name: 'Add filter', exact: true }).click();
  await first.getByRole('searchbox', { name: 'Search filters', exact: true }).press('Escape');
  await expect(first.getByRole('searchbox', { name: 'Search filters', exact: true })).toHaveCount(0);
  await expect(first.getByRole('button', { name: 'Add filter', exact: true })).toBeFocused();
  await expect(filters(first)).toBeVisible();
  const input = await addDepth(first);
  await input.fill('75');
  await expect(first.getByRole('button', { name: 'Apply filters', exact: true })).toBeEnabled();
  const inputHandle = await input.elementHandle();
  await first.locator('sample-sift-map').evaluate((element: TestMap) => {
    element.saved = { map: element._map, draw: element._draw, center: element._map.getCenter().toArray(), zoom: element._map.getZoom(), selection: structuredClone(element.selection) };
  });
  const count = calls.length, url = page.url();
  await input.press('Escape');
  await expect(filters(first)).toBeHidden();
  await expect(filtersToggle(first)).toBeFocused();
  await expect(first.locator('[part="compact-summary"]')).toContainText(/unapplied|draft|changes/i);
  await resultsToggle(first).click();
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-record-id', 'COMPACT-2');
  await first.getByRole('button', { name: 'Close results', exact: true }).click();
  await expect(resultsToggle(first)).toBeFocused();
  await filtersToggle(first).click();
  await expect(input).toHaveValue('75');
  expect(await input.evaluate((element, saved) => element === saved, inputHandle)).toBe(true);
  expect(await first.locator('sample-sift-map').evaluate((element: TestMap) => ({
    sameMap: element.saved?.map === element._map,
    sameDraw: element.saved?.draw === element._draw,
    sameCenter: JSON.stringify(element.saved?.center) === JSON.stringify(element._map.getCenter().toArray()),
    sameZoom: element.saved?.zoom === element._map.getZoom(),
    sameSelection: JSON.stringify(element.saved?.selection) === JSON.stringify(element.selection),
  }))).toEqual({ sameMap: true, sameDraw: true, sameCenter: true, sameZoom: true, sameSelection: true });
  expect(calls.length).toBe(count);
  expect(page.url()).toBe(url);
  await expect(filters(second)).toBeHidden();
  await first.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => calls.length).toBe(count + 1);
  await first.getByRole('button', { name: 'Close filters', exact: true }).click();
  await expect(first.locator('[part="compact-summary"]')).toContainText(/depth/i);
});

test('host layout changes and map Layers preserve the current view and coordinate panel visibility', async ({ page }) => {
  const { first, calls } = await open(page);
  await first.evaluate((element: SampleSift) => {
    element.showTable = true;
    element.mapLayers = { basemaps: [{ id: 'local', label: 'Local map', tiles: ['http://127.0.0.1:5173/__compact-layer/{z}/{x}/{y}.png'], attribution: 'Test map', maxZoom: 0 }] };
  });
  await expect(first.getByRole('button', { name: 'Layers', exact: true })).toBeVisible();
  const count = calls.length;
  await filtersToggle(first).click();
  const input = await addDepth(first);
  await input.fill('90');
  await first.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(filters(first)).toBeHidden();
  await expect(first.getByRole('region', { name: 'Map layers', exact: true })).toBeVisible();
  await filtersToggle(first).click();
  await expect(first.getByRole('region', { name: 'Map layers', exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('90');
  await first.locator('sample-sift-map').evaluate((element: TestMap) => { element.saved = { map: element._map, draw: element._draw, center: element._map.getCenter().toArray(), zoom: element._map.getZoom(), selection: structuredClone(element.selection) }; });
  await first.evaluate((element: SampleSift) => { element.layout = 'full'; });
  await expect(first.getByTestId('collection-results')).toBeVisible();
  await expect(input).toHaveValue('90');
  await first.evaluate((element: SampleSift) => { element.layout = 'compact'; });
  if (await filtersToggle(first).getAttribute('aria-expanded') !== 'true') await filtersToggle(first).click();
  await expect(input).toHaveValue('90');
  expect(await first.locator('sample-sift-map').evaluate((element: TestMap) => element.saved?.map === element._map)).toBe(true);
  expect(calls.length).toBe(count);
  expect(await page.evaluate(() => (window as unknown as { compactEvents: string[] }).compactEvents)).toEqual([]);
});

test('a narrow embedded card stays bounded on a wide page and its panels scroll internally', async ({ page }, testInfo) => {
  const { first } = await open(page);
  await first.evaluate((element: SampleSift) => {
    element.style.width = '360px'; element.showTable = true;
    element.mapLayers = { basemaps: [{ id: 'local', label: 'Local map', tiles: ['http://127.0.0.1:5173/__compact-layer/{z}/{x}/{y}.png'], attribution: '<a href="https://example.org/map">Test map</a>', maxZoom: 0 }] };
  });
  await filtersToggle(first).click();
  const input = await addDepth(first);
  await input.fill('15');
  const dimensions = await first.evaluate(element => {
    const shell = element.shadowRoot?.querySelector('sample-sift-collection')?.shadowRoot?.querySelector<HTMLElement>('[part="explorer"]');
    const panel = shell?.querySelector<HTMLElement>('[data-panel="filters"]');
    return { shell: shell?.getBoundingClientRect().toJSON(), panel: panel?.getBoundingClientRect().toJSON(), overflow: panel && getComputedStyle(panel).overflowY };
  });
  expect(dimensions.shell?.width).toBe(360);
  expect(dimensions.shell?.height).toBe(480);
  expect(dimensions.panel?.left).toBeGreaterThanOrEqual(dimensions.shell?.left ?? 0);
  expect(dimensions.panel?.right).toBeLessThanOrEqual(dimensions.shell?.right ?? 0);
  expect(dimensions.panel?.bottom).toBeLessThanOrEqual(dimensions.shell?.bottom ?? 0);
  expect(['auto', 'scroll']).toContain(dimensions.overflow);
  await input.press('Tab');
  const maximum = first.getByRole('group', { name: 'Depth filter', exact: true }).getByRole('spinbutton').last();
  await expect(maximum).toBeFocused();
  await maximum.fill('100');
  await maximum.click({ trial: true });
  const maximumBox = await maximum.boundingBox(), actionsBox = await first.locator('[part="filter-actions"]').boundingBox();
  expect(maximumBox && actionsBox && maximumBox.y + maximumBox.height + 2 <= actionsBox.y).toBe(true);
  await first.locator('.maplibregl-ctrl-attrib-button').click({ trial: true });
  await first.screenshot({ path: testInfo.outputPath('compact-filters-narrow.png') });
  await resultsToggle(first).click();
  await expect(filters(first)).toBeHidden();
  await expect(first.getByTestId('collection-results')).toBeVisible();
  await expect(first.locator('[part="explorer"]')).toHaveCSS('height', '480px');
  await first.locator('.maplibregl-ctrl-attrib-button').click({ trial: true });
  const attribution = first.getByRole('link', { name: 'Test map', exact: true });
  if (!await attribution.isVisible()) await first.locator('.maplibregl-ctrl-attrib-button').click();
  await expect(attribution).toBeVisible();
  await attribution.click({ trial: true });
  const attributionBox = await attribution.boundingBox(), resultsBox = await results(first).boundingBox();
  expect(attributionBox?.y).toBeGreaterThanOrEqual((resultsBox?.y ?? 0) + (resultsBox?.height ?? 0));
  await first.screenshot({ path: testInfo.outputPath('compact-results-narrow.png') });
});

test('loading and retry feedback remain available with no table and all panels closed', async ({ page }) => {
  const { first, calls, behavior } = await open(page);
  behavior.hold = true;
  const count = calls.length;
  await first.evaluate((element: SampleSift) => { void element.refresh(); });
  await expect.poll(() => calls.length).toBe(count + 1);
  await expect(first.locator('[part="compact-summary"]')).toContainText(/updating|loading|finding/i);
  behavior.fail = true; behavior.hold = false; behavior.release?.();
  await expect(first.getByRole('button', { name: /retry search/i })).toBeVisible();
  await expect(filters(first)).toBeHidden();
  await expect(first.locator('table')).toHaveCount(0);
  behavior.fail = false;
  await first.getByRole('button', { name: /retry search/i }).click();
  await expect.poll(() => calls.length).toBe(count + 2);
  await expect(first.getByRole('button', { name: /retry search/i })).toHaveCount(0);
  await expect(first.locator('[part="compact-toolbar"]')).toContainText('6');
});

test('legacy sample mode also defaults to a compact map with an optional table', async ({ page }) => {
  await page.goto('/demo/contract.html');
  await page.evaluate(() => {
    const explorer = document.createElement('sample-sift') as SampleSift;
    explorer.id = 'legacy-compact'; explorer.demo = true;
    explorer.mapStyle = { version: 8, sources: {}, layers: [] };
    document.body.append(explorer);
  });
  const explorer = page.locator('#legacy-compact');
  await expect(explorer.locator('canvas')).toBeVisible();
  await expect(explorer.locator('[part="explorer"]')).toHaveCSS('height', '480px');
  await expect(explorer.locator('table')).toHaveCount(0);
  await expect(resultsToggle(explorer)).toHaveCount(0);
  await filtersToggle(explorer).click();
  await expect(explorer.getByLabel('Biome', { exact: true })).toBeVisible();
  await explorer.getByRole('button', { name: 'Close filters', exact: true }).click();
  await expect(filtersToggle(explorer)).toBeFocused();
  await explorer.evaluate((element: SampleSift) => { element.showTable = true; });
  await expect(results(explorer)).toBeHidden();
  await resultsToggle(explorer).click();
  await expect(explorer.getByTestId('results-table')).toBeVisible();
  await expect(explorer.locator('tbody tr')).toHaveCount(10);
  await explorer.evaluate((element: SampleSift) => { element.layout = 'full'; element.showTable = false; });
  await expect(filters(explorer)).toBeVisible();
  await expect(explorer.locator('table')).toHaveCount(0);
});


test('a standalone collection uses the same compact defaults and opt-in controls', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const explorer = document.createElement('sample-sift-collection') as SampleSiftCollection;
    explorer.id = 'standalone';
    explorer.options = { baseUrl: '/samplesift', collection: 'occurrences', tiles: { sourceLayer: 'occurrences' } };
    explorer.mapStyle = { version: 8, sources: {}, layers: [] };
    document.body.append(explorer);
  });
  const explorer = page.locator('#standalone');
  await expect(explorer.locator('[part="compact-toolbar"]')).toContainText('6');
  await expect(explorer.locator('[part="explorer"]')).toHaveCSS('height', '480px');
  await expect(filters(explorer)).toBeHidden();
  await expect(explorer.locator('table')).toHaveCount(0);
  await expect(resultsToggle(explorer)).toHaveCount(0);
  await explorer.evaluate(element => element.setAttribute('layout', 'full'));
  await expect(filters(explorer)).toBeVisible();
  await expect(explorer.locator('table')).toHaveCount(0);
  await explorer.evaluate(element => { element.setAttribute('layout', 'compact'); element.setAttribute('show-table', ''); });
  await expect(resultsToggle(explorer)).toBeVisible();
  await expect(results(explorer)).toBeHidden();
  await resultsToggle(explorer).click();
  await expect(explorer.getByTestId('collection-results')).toBeVisible();
});


test('changing layout and table availability keeps keyboard focus on visible controls', async ({ page }) => {
  const { first, calls } = await open(page);
  const count = calls.length;
  await first.evaluate((element: SampleSift) => { element.showTable = true; });
  await filtersToggle(first).click();
  await expect(filters(first).locator('[data-panel-heading]')).toBeFocused();
  await first.evaluate((element: SampleSift) => { element.layout = 'full'; });
  await expect(filters(first)).toBeFocused();
  await first.evaluate((element: SampleSift) => { element.layout = 'compact'; });
  if (await filtersToggle(first).getAttribute('aria-expanded') !== 'true') await filtersToggle(first).click();
  await first.getByRole('button', { name: 'Close filters', exact: true }).focus();
  await first.evaluate((element: SampleSift) => { element.layout = 'full'; });
  await expect(filters(first)).toBeFocused();
  const input = await addDepth(first);
  await input.fill('90');
  await expect(input).toBeFocused();
  await first.evaluate((element: SampleSift) => { element.layout = 'compact'; });
  await expect(filters(first)).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('90');
  await first.getByRole('button', { name: 'Close filters', exact: true }).click();
  await resultsToggle(first).focus();
  await first.evaluate((element: SampleSift) => { element.showTable = false; });
  await expect(filtersToggle(first)).toBeFocused();
  await first.evaluate((element: SampleSift) => { element.showTable = true; });
  await resultsToggle(first).click();
  await expect(results(first).locator('[data-panel-heading]')).toBeFocused();
  await first.evaluate((element: SampleSift) => { element.showTable = false; });
  await expect(filtersToggle(first)).toBeFocused();
  expect(calls.length).toBe(count);
});
