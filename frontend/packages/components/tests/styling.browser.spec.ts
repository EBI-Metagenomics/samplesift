import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Locator } from '@playwright/test';
import type { SampleSift } from '../src/components/sample-sift';
import type { SampleSiftCollection } from '../src/components/collection-explorer';
import type { SampleSiftCollectionFilterForm } from '../src/components/collection-filter-form';
import type { SampleSiftMap } from '../src/components/selection-map';

const tile = readFileSync(new URL('./fixtures/collection.mvt', import.meta.url));
const queryables = { type: 'object', properties: {
  depth: { type: 'number', 'x-samplesift': { operators: ['=', '>=', '<='] } },
  geometry: { type: 'object', 'x-samplesift': { operators: ['s_intersects'] } },
} };
const openapi = { openapi: '3.2.1', paths: { '/samplesift/collections/occurrences/results': { query: {
  requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
    filter: { type: 'object' }, sort: { type: 'array', items: { type: 'string', enum: ['depth', '-depth'] } }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, offset: { type: 'integer', minimum: 0 },
  } } } } },
  responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: {
    type: 'object', properties: { source_pk: { type: 'string' }, geometry: { type: ['object', 'null'] }, depth: { type: 'number' } },
  } } } } } } } },
} } } };

async function open(page: Page) {
  const requests: string[] = [];
  await page.route(/\/samplesift\/(?:openapi\.json|collections\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/openapi.json')) return route.fulfill({ json: openapi });
    if (path.endsWith('/queryables')) return route.fulfill({ json: queryables });
    if (path.includes('/tiles/')) return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: tile });
    return route.fulfill({ json: { items: [{ source_pk: 'ONE', depth: 10, geometry: { type: 'Point', coordinates: [0, 0] } }], total: 1, limit: 2, offset: 0 } });
  });
  await page.goto('/demo/collection.html?host=preserved#route');
  const first = page.locator('#first'), second = page.locator('#second');
  for (const explorer of [first, second]) {
    await expect(explorer.getByTestId('collection-count')).toHaveText('1 record');
    await expect(explorer.locator('canvas')).toBeVisible();
    await expect(explorer.getByTestId('tile-loading')).toHaveCount(0);
  }
  return { first, second, requests };
}

async function addDepth(explorer: Locator) {
  await explorer.getByRole('button', { name: 'Add filter', exact: true }).click();
  await explorer.getByRole('button', { name: 'Add Depth filter', exact: true }).click();
  return explorer.getByRole('group', { name: 'Depth filter', exact: true }).getByRole('spinbutton').first();
}

test('defaults stay intact; inherited theme and exported parts reach nested UI without changing state', async ({ page }, testInfo) => {
  const { first, second, requests } = await open(page);
  const input = await addDepth(first);
  await input.fill('25');
  const apply = first.getByRole('button', { name: 'Apply filters', exact: true });
  await expect(apply).toBeEnabled();
  await input.blur();
  await expect(first.locator('[part="explorer"]')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(first.locator('[part="filter-panel"]')).toHaveCSS('background-color', 'rgb(248, 250, 246)');
  await expect(apply).toHaveCSS('background-color', 'rgb(27, 112, 92)');
  await expect(first.locator('[part="map-toolbar"]')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.97)');
  await expect(input).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await first.screenshot({ path: testInfo.outputPath('default.png') });
  const before = requests.length, url = page.url();
  await first.locator('sample-sift-map').evaluate(element => {
    const target = element as HTMLElement & { _map: unknown; savedMap?: unknown };
    target.savedMap = target._map;
  });
  const stylesheet = await page.addStyleTag({ content: `
    body { --samplesift-font: Georgia, serif; }
    #first {
      --samplesift-accent: #663399; --samplesift-surface: #fef9ff; --samplesift-surface-muted: #f2eafa;
      --samplesift-text: #29133f; --samplesift-control-background: #ece1fa;
      --samplesift-control-text: #271142; --samplesift-control-border-color: #663399;
      --samplesift-control-radius: 9px; --samplesift-focus-color: #c1238e;
    }
    #first::part(apply-button) { border-radius: 19px; letter-spacing: 1px; }
    #first::part(map-toolbar) { border-width: 3px; }
    #first::part(table-header-cell) { text-transform: none; }
    #first::part(filter-card) { border-style: dashed; }
  ` });
  await expect(apply).toHaveCSS('background-color', 'rgb(102, 51, 153)');
  await expect(apply).toHaveCSS('border-radius', '19px');
  await expect(input).toHaveCSS('background-color', 'rgb(236, 225, 250)');
  await expect(input).toHaveCSS('color', 'rgb(39, 17, 66)');
  await expect(input.locator('..')).toHaveCSS('border-top-color', 'rgb(102, 51, 153)');
  await expect(input.locator('..')).toHaveCSS('border-radius', '9px');
  await expect(input).toHaveCSS('font-family', 'Georgia, serif');
  await input.focus();
  await expect(input.locator('..')).toHaveCSS('border-top-color', 'rgb(193, 35, 142)');
  await expect(first.locator('[part="map-toolbar"]')).toHaveCSS('border-top-width', '3px');
  await expect(first.locator('[part="table-header-cell"]').first()).toHaveCSS('text-transform', 'none');
  await expect(first.locator('[part="filter-card"]')).toHaveCSS('border-top-style', 'dashed');
  await expect(second.locator('[part="filter-panel"]')).toHaveCSS('background-color', 'rgb(248, 250, 246)');
  await expect(second.getByRole('button', { name: 'Apply filters', exact: true })).toHaveCSS('border-radius', '7.2px');
  await expect(input).toHaveValue('25');
  expect(page.url()).toBe(url);
  expect(requests.length).toBe(before);
  expect(await first.locator('sample-sift-map').evaluate(element => {
    const target = element as HTMLElement & { _map: unknown; savedMap?: unknown };
    return target._map === target.savedMap;
  })).toBe(true);
  await first.screenshot({ path: testInfo.outputPath('themed.png') });
  await stylesheet.evaluate(element => element.remove());
  await expect(apply).toHaveCSS('background-color', 'rgb(27, 112, 92)');
  await expect(input).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(input).toHaveValue('25');
});

test('standalone collection, map and filter form expose the same theme hooks', async ({ page }) => {
  const { first } = await open(page);
  await first.evaluate((element: SampleSift) => {
    const parent = document.createElement('div'); parent.id = 'standalone';
    parent.style.setProperty('--samplesift-accent', '#2345ab');
    parent.style.setProperty('--samplesift-control-background', '#edf2ff');
    const map = document.createElement('sample-sift-map') as SampleSiftMap;
    map.id = 'map-only'; map.style.height = '360px'; map.mapStyle = { version: 8, sources: {}, layers: [] };
    const form = document.createElement('sample-sift-collection-filter-form') as SampleSiftCollectionFilterForm;
    form.id = 'form-only'; form.metadata = element.collectionMetadata;
    const collection = document.createElement('sample-sift-collection') as SampleSiftCollection;
    collection.id = 'collection-only'; collection.options = { baseUrl: '/samplesift', collection: 'occurrences' };
    collection.mapStyle = { version: 8, sources: {}, layers: [] };
    parent.append(map, form, collection); document.body.append(parent);
  });
  await page.addStyleTag({ content: `
    #map-only::part(map-toolbar) { border-radius: 23px; }
    #form-only::part(apply-button), #collection-only::part(apply-button) { border-radius: 21px; }
    #collection-only::part(map-toolbar) { border-radius: 22px; }
  ` });
  const form = page.locator('#form-only'), collection = page.locator('#collection-only');
  await expect(collection.getByTestId('collection-count')).toHaveText('1 record');
  await expect(page.locator('#map-only').locator('button[aria-pressed="true"]').first()).toHaveCSS('background-color', 'rgb(35, 69, 171)');
  await expect(page.locator('#map-only [part="map-toolbar"]')).toHaveCSS('border-radius', '23px');
  for (const target of [form, collection]) {
    await expect(target.getByRole('button', { name: 'Apply filters', exact: true })).toHaveCSS('border-radius', '21px');
    const input = await addDepth(target);
    await expect(input).toHaveCSS('background-color', 'rgb(237, 242, 255)');
  }
  await expect(collection.locator('[part="map-toolbar"]')).toHaveCSS('border-radius', '22px');
});

test('legacy sample explorer forwards map parts and inherits theme variables', async ({ page }) => {
  await page.goto('/demo/contract.html');
  const first = page.locator('#first'), second = page.locator('#second');
  await expect(first.getByTestId('results-table')).toBeVisible();
  await expect(first.locator('[part="explorer"]')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.addStyleTag({ content: `
    body { --samplesift-accent: #1234ab; }
    #first { --samplesift-surface: #fff9f2; --samplesift-control-background: #fff0e0; }
    #first::part(record-link) { text-decoration-line: underline; }
    #first::part(map-toolbar) { border-radius: 17px; }
  ` });
  await expect(first.locator('[part="explorer"]')).toHaveCSS('background-color', 'rgb(255, 249, 242)');
  await expect(first.locator('[part="record-link"]').first()).toHaveCSS('color', 'rgb(18, 52, 171)');
  await expect(first.locator('[part="record-link"]').first()).toHaveCSS('text-decoration-line', 'underline');
  await expect(first.locator('[part="map-toolbar"]')).toHaveCSS('border-radius', '17px');
  await expect(first.locator('#n50-min')).toHaveCSS('background-color', 'rgb(255, 240, 224)');
  await expect(second.locator('[part="explorer"]')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
