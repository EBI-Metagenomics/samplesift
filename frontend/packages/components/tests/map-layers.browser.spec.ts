import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';
import type { SampleSift } from '../src/components/sample-sift';
import type { CollectionQuery } from '../src/collection/types';
import type { CollectionTileSource } from '../src/collection/tiles';
import type { MapLayerCatalog, MapLayerState } from '../src/map/layers';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNImFn+HwAFPQJwCzX1rQAAAABJRU5ErkJggg==', 'base64');
const mvt = readFileSync(new URL('./fixtures/collection.mvt', import.meta.url));
const catalog: MapLayerCatalog = {
  basemaps: ['standard', 'satellite', 'topographic'].map(id => ({
    id, label: `${id[0].toUpperCase()}${id.slice(1)}`,
    tiles: [`http://127.0.0.1:5173/__layer-fixture/${id}/{z}/{x}/{y}.png`],
    tileSize: 256, maxZoom: 0, attribution: `Test ${id} attribution`,
  })),
  overlays: [{
    id: 'worldcover-2021', label: 'WorldCover', year: 2021, maxZoom: 0,
    tiles: ['http://127.0.0.1:5173/__layer-fixture/worldcover-2021/{z}/{x}/{y}.png'],
    tileSize: 256, attribution: 'Test WorldCover attribution', resampling: 'nearest',
    legend: [{ label: 'Tree cover', color: '#006400' }, { label: 'Cropland', color: '#ffff4c' }],
  }],
};
const state = (basemap = 'standard', visible = false, opacity = 0.45): MapLayerState => ({
  basemap, overlays: { 'worldcover-2021': { visible, opacity } },
});
const queryables = { type: 'object', properties: {
  depth: { type: 'number', 'x-samplesift': { operators: ['=', '>=', '<='] } },
  geometry: { type: 'object', 'x-samplesift': { operators: ['s_intersects'] } },
} };
const openapi = { openapi: '3.2.1', paths: { '/samplesift/collections/occurrences/results': { query: {
  requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
    filter: { type: 'object' }, sort: { type: 'array', items: { type: 'string', enum: ['depth', '-depth'] } },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, offset: { type: 'integer', minimum: 0 },
  } } } } },
  responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: {
    type: 'object', properties: { source_pk: { type: 'string' }, geometry: { type: ['object', 'null'] }, depth: { type: 'number' } },
  } } } } } } } },
} } } };
const rows = [10, 50, 100].map((depth, i) => ({ source_pk: `LAYER-${i}`, depth, geometry: { type: 'Point', coordinates: [i, i] } }));

type TestMap = HTMLElement & {
  _map: MapLibreMap;
  _draw: TerraDraw;
  _collectionSourceId: string;
  selection: Polygon | null;
  tileSource: CollectionTileSource;
  mapLayerState: MapLayerState;
  _layerTestSaved?: { map: MapLibreMap; draw: TerraDraw; source: unknown };
};

async function open(page: Page) {
  const queries: CollectionQuery[] = [], tiles: CollectionQuery[] = [], providers: string[] = [], foreign: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5173)/, route => {
    foreign.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/__layer-fixture/**', route => {
    providers.push(new URL(route.request().url()).pathname.split('/')[2]);
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route(/\/samplesift\/(?:openapi\.json|collections\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/openapi.json')) return route.fulfill({ json: openapi });
    if (path.endsWith('/queryables')) return route.fulfill({ json: queryables });
    expect(route.request().method()).toBe('QUERY');
    const query = route.request().postDataJSON() as CollectionQuery;
    if (path.includes('/tiles/')) {
      tiles.push(query);
      return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: mvt });
    }
    queries.push(query);
    const items = query.filter ? rows.slice(1) : rows;
    return route.fulfill({ json: { items: items.slice(0, query.limit ?? 100), total: items.length, limit: query.limit ?? 100, offset: query.offset ?? 0 } });
  });
  await page.addInitScript(() => {
    (window as unknown as { layerEvents: unknown[] }).layerEvents = [];
    document.addEventListener('maplayerchange', event => {
      (window as unknown as { layerEvents: unknown[] }).layerEvents.push({
        target: event.target instanceof HTMLElement ? event.target.id : '',
        detail: structuredClone((event as CustomEvent).detail),
      });
    });
  });
  await page.goto('/demo/collection.html?host=preserve&tag=a&tag=b#host');
  const first = page.locator('#first'), second = page.locator('#second');
  for (const explorer of [first, second]) {
    await expect(explorer.getByTestId('collection-count')).toHaveText('3 records');
    await explorer.evaluate((element: SampleSift) => {
      element.collectionOptions = { baseUrl: '/samplesift', collection: 'occurrences', tiles: { sourceLayer: 'occurrences', minZoom: 0, maxZoom: 0 } };
    });
    await expect(explorer.locator('sample-sift-map canvas')).toBeVisible();
    await expect.poll(() => explorer.locator('sample-sift-map').evaluate((element: TestMap) => Boolean(element._map?.getSource(element._collectionSourceId)))).toBe(true);
    await expect(explorer.getByTestId('tile-loading')).toHaveCount(0);
  }
  return { first, second, queries, tiles, providers, foreign };
}

async function configure(explorer: Locator, initial = state()) {
  await explorer.evaluate(async (element: SampleSift, options) => {
    element.mapLayers = options.catalog;
    element.mapLayerState = options.state;
    await element.updateComplete;
  }, { catalog, state: initial });
  await expect(explorer.getByRole('button', { name: 'Layers', exact: true })).toBeVisible();
}

async function panel(explorer: Locator) {
  const button = explorer.getByRole('button', { name: 'Layers', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  return explorer.getByRole('region', { name: 'Map layers', exact: true });
}

async function saveMap(explorer: Locator) {
  return explorer.locator('sample-sift-map').evaluate((element: TestMap) => {
    element._layerTestSaved = { map: element._map, draw: element._draw, source: element._map.getSource(element._collectionSourceId) };
    return {
      center: element._map.getCenter().toArray(), zoom: element._map.getZoom(),
      selection: structuredClone(element.selection), query: structuredClone(element.tileSource.body),
    };
  });
}
async function checkMap(explorer: Locator) {
  return explorer.locator('sample-sift-map').evaluate((element: TestMap) => ({
    sameMap: element._layerTestSaved?.map === element._map,
    sameDraw: element._layerTestSaved?.draw === element._draw,
    sameSource: element._layerTestSaved?.source === element._map.getSource(element._collectionSourceId),
    snapshot: {
      center: element._map.getCenter().toArray(), zoom: element._map.getZoom(),
      selection: structuredClone(element.selection), query: structuredClone(element.tileSource.body),
    },
  }));
}
async function rasterLayers(explorer: Locator) {
  return explorer.locator('sample-sift-map').evaluate((element: TestMap) => {
    const style = element._map.getStyle();
    return style.layers.flatMap(layer => {
      if (layer.type !== 'raster') return [];
      const source = style.sources[layer.source];
      if (source.type !== 'raster' || !source.tiles?.some(url => url.includes('/__layer-fixture/'))) return [];
      return [{ id: layer.id, url: source.tiles[0], opacity: element._map.getPaintProperty(layer.id, 'raster-opacity'), visibility: element._map.getLayoutProperty(layer.id, 'visibility') }];
    });
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('custom map styles remain unchanged without a catalog, and host layer state stays silent and instance-local', async ({ page }) => {
  const { first, second, providers, foreign, queries } = await open(page);
  await expect(first.getByRole('button', { name: 'Layers', exact: true })).toHaveCount(0);
  expect(providers).toEqual([]);
  expect(foreign).toEqual([]);
  const before = queries.length;
  await configure(first, state('satellite', true, 0.3));
  await expect.poll(() => providers.includes('satellite') && providers.includes('worldcover-2021')).toBe(true);
  expect(providers).not.toContain('standard');
  expect(providers).not.toContain('topographic');
  await expect(second.getByRole('button', { name: 'Layers', exact: true })).toHaveCount(0);
  const layers = await panel(first);
  await expect(layers.getByRole('radio', { name: 'Satellite', exact: true })).toBeChecked();
  await expect(layers.getByRole('checkbox', { name: 'WorldCover', exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { layerEvents: unknown[] }).layerEvents)).toEqual([]);
  expect(queries).toHaveLength(before);
  await configure(second);
  const rightLayers = await panel(second);
  await expect(rightLayers.getByRole('radio', { name: 'Standard', exact: true })).toBeChecked();
  await expect(rightLayers.getByRole('checkbox', { name: 'WorldCover', exact: true })).not.toBeChecked();
  await first.evaluate((element: SampleSift, next) => { element.mapLayerState = next; }, state('topographic', false, 0.7));
  await expect(layers.getByRole('radio', { name: 'Topographic', exact: true })).toBeChecked();
  await expect(rightLayers.getByRole('radio', { name: 'Standard', exact: true })).toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { layerEvents: unknown[] }).layerEvents)).toEqual([]);
  expect(queries).toHaveLength(before);
});

test('layer controls change display lazily without replacing the map, sample query or unfinished polygon', async ({ page }) => {
  const { first, second, providers, queries, tiles } = await open(page);
  await configure(first);
  await expect.poll(() => providers.includes('standard')).toBe(true);
  expect(providers).not.toContain('satellite');
  expect(providers).not.toContain('topographic');
  expect(providers).not.toContain('worldcover-2021');
  const selection: Polygon = { type: 'Polygon', coordinates: [[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]] };
  await first.evaluate((element: SampleSift, selection) => element.setCollectionState({ predicates: [{ field: 'depth', operator: '>=', value: 50 }], sort: ['-depth'], selection }), selection);
  await expect(first.getByTestId('collection-count')).toHaveText('2 records');
  await expect(first.getByTestId('tile-loading')).toHaveCount(0);
  const before = await saveMap(first);
  const calls = { queries: queries.length, tiles: tiles.length }, href = page.url();
  const map = first.locator('sample-sift-map'), canvas = map.locator('canvas').first();
  await map.getByRole('button', { name: 'Polygon', exact: true }).click();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Map canvas has no bounds.');
  await canvas.click({ position: { x: bounds.width * 0.4, y: bounds.height * 0.6 } });
  await canvas.click({ position: { x: bounds.width * 0.65, y: bounds.height * 0.6 } });
  const draft = await map.evaluate((element: TestMap) => element._draw.getSnapshot());
  expect(draft.length).toBeGreaterThan(0);
  const layers = await panel(first);
  await layers.getByRole('radio', { name: 'Satellite', exact: true }).check();
  await expect.poll(() => providers.includes('satellite')).toBe(true);
  await layers.getByRole('checkbox', { name: 'WorldCover', exact: true }).check();
  await expect.poll(() => providers.includes('worldcover-2021')).toBe(true);
  const opacity = layers.getByRole('slider', { name: 'WorldCover opacity', exact: true });
  await opacity.evaluate((element: HTMLInputElement) => {
    element.value = '70';
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  });
  await expect.poll(async () => (await rasterLayers(first)).find(layer => layer.url.includes('worldcover-2021'))?.opacity).toBe(0.7);
  const after = await checkMap(first);
  expect(after).toEqual({ sameMap: true, sameDraw: true, sameSource: true, snapshot: before });
  const retainedDraft = await map.evaluate((element: TestMap) => element._draw.getSnapshot());
  expect(retainedDraft.map(feature => feature.id)).toEqual(draft.map(feature => feature.id));
  const originalPolygon = draft.find(feature => feature.geometry.type === 'Polygon');
  const retainedPolygon = retainedDraft.find(feature => feature.geometry.type === 'Polygon');
  if (!originalPolygon || !retainedPolygon) throw new Error('The unfinished polygon was lost.');
  expect((retainedPolygon.geometry as Polygon).coordinates[0].slice(0, 2)).toEqual((originalPolygon.geometry as Polygon).coordinates[0].slice(0, 2));
  await expect(map.getByRole('button', { name: 'Polygon', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect({ queries: queries.length, tiles: tiles.length }).toEqual(calls);
  expect(page.url()).toBe(href);
  await expect(second.getByTestId('collection-count')).toHaveText('3 records');
  expect(await first.evaluate((element: SampleSift) => element.collectionState)).toEqual({ predicates: [{ field: 'depth', operator: '>=', value: 50 }], sort: ['-depth'], selection });
  const eventStates = await page.evaluate(() => (window as unknown as { layerEvents: { detail: { state: MapLayerState } }[] }).layerEvents.map(event => event.detail.state));
  expect(eventStates).toEqual([state('satellite'), state('satellite', true), state('satellite', true, 0.7)]);
  await layers.getByRole('checkbox', { name: 'WorldCover', exact: true }).uncheck();
  const active = await rasterLayers(first);
  expect(active.filter(layer => layer.url.includes('worldcover-2021') && layer.visibility !== 'none')).toEqual([]);
  expect((await checkMap(first)).sameSource).toBe(true);
});

test('provider retries and stale failures are isolated from collection tile failures', async ({ page }) => {
  const { first, second, queries, tiles } = await open(page);
  await configure(first);
  const layers = await panel(first), stale = deferred();
  let staleRequests = 0, worldRequests = 0, worldFails = true;
  await page.route('**/__layer-fixture/satellite/**', async route => {
    staleRequests++;
    await stale.promise;
    await route.fulfill({ status: 503, body: 'Old satellite request failed' }).catch(() => {});
  });
  await page.route('**/__layer-fixture/worldcover-2021/**', route => {
    worldRequests++;
    return worldFails ? route.fulfill({ status: 503, body: 'WorldCover unavailable' }) : route.fulfill({ contentType: 'image/png', body: png });
  });
  try {
    await layers.getByRole('radio', { name: 'Satellite', exact: true }).check();
    await expect.poll(() => staleRequests).toBeGreaterThan(0);
    await layers.getByRole('radio', { name: 'Standard', exact: true }).check();
    stale.resolve();
    await expect(first.getByRole('button', { name: 'Retry Satellite', exact: true })).toHaveCount(0);
    await expect(first.getByTestId('tile-error')).toHaveCount(0);
    const saved = await saveMap(first), tableCalls = queries.length, tileCalls = tiles.length;
    await layers.getByRole('checkbox', { name: 'WorldCover', exact: true }).check();
    await expect(first.getByRole('button', { name: 'Retry WorldCover', exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Retry Satellite', exact: true })).toHaveCount(0);
    await expect(first.getByTestId('tile-error')).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'Retry WorldCover', exact: true })).toHaveCount(0);
    const failedCalls = worldRequests;
    worldFails = false;
    await first.getByRole('button', { name: 'Retry WorldCover', exact: true }).click();
    await expect.poll(() => worldRequests).toBeGreaterThan(failedCalls);
    await expect(first.getByRole('button', { name: 'Retry WorldCover', exact: true })).toHaveCount(0);
    expect(queries).toHaveLength(tableCalls);
    expect(tiles).toHaveLength(tileCalls);
    expect(await checkMap(first)).toEqual({ sameMap: true, sameDraw: true, sameSource: true, snapshot: saved });
    let failedSampleRequests = 0;
    await page.route('**/samplesift/collections/occurrences/tiles/**', route => {
      if (!(route.request().postDataJSON() as CollectionQuery).filter) return route.fallback();
      failedSampleRequests++;
      return route.fulfill({ status: 503, body: 'Sample tiles unavailable' });
    });
    await first.evaluate((element: SampleSift) => element.setCollectionState({ predicates: [{ field: 'depth', operator: '>=', value: 50 }], sort: [], selection: null }));
    await expect(first.getByTestId('tile-error')).toContainText('HTTP 503');
    const failures = failedSampleRequests;
    await layers.getByRole('radio', { name: 'Topographic', exact: true }).check();
    await expect(first.getByTestId('tile-error')).toContainText('HTTP 503');
    expect(failedSampleRequests).toBe(failures);
    await expect(first.getByRole('button', { name: 'Retry map tiles', exact: true })).toBeVisible();
    await expect(second.getByTestId('tile-error')).toHaveCount(0);
    await expect(first.getByTestId('collection-count')).toHaveText('2 records');
  } finally { stale.resolve(); }
});

test('the mobile layer panel remains within the viewport and exposes labelled keyboard controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { first } = await open(page);
  await configure(first);
  const layers = await panel(first);
  await expect(layers).toBeVisible();
  await expect(layers.getByRole('group', { name: 'Basemap', exact: true })).toBeVisible();
  const bounds = await layers.boundingBox();
  if (!bounds) throw new Error('Map layers panel has no visible bounds.');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const satellite = layers.getByRole('radio', { name: 'Satellite', exact: true });
  await satellite.focus();
  await satellite.press('Space');
  await expect(satellite).toBeChecked();
  const overlay = layers.getByRole('checkbox', { name: 'WorldCover', exact: true });
  await overlay.focus();
  await overlay.press('Space');
  await expect(overlay).toBeChecked();
  await expect(layers.getByRole('slider', { name: 'WorldCover opacity', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
