import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { SampleSift } from '../src/components/sample-sift';
import type {
  ResultsChangeDetail,
  Sample,
  SearchQuery,
  SearchResult,
  SelectionChangeDetail,
} from '../src/types';

interface PendingSearch {
  query: SearchQuery;
  signal: AbortSignal;
  resolve: (result: SearchResult) => void;
}

declare global {
  interface Window {
    __selectionEvents: SelectionChangeDetail[];
    __resultsEvents: ResultsChangeDetail[];
    __drawEvents: SelectionChangeDetail[];
    __pendingSearches: PendingSearch[];
  }
}

const samples: Sample[] = Array.from({ length: 24 }, (_, index) => ({
  accession: `TEST-${String(index + 1).padStart(3, '0')}`,
  title: `Browser test sample ${index + 1}`,
  longitude: index < 8 ? -5 : 30,
  latitude: index < 8 ? 40 : 0,
  biome: index < 16 ? 'Marine' : 'Soil',
  collectionDate: index === 0 ? null : `2024-01-${String(index + 1).padStart(2, '0')}`,
}));

async function openContract(page: Page) {
  await page.goto('/demo/contract.html');
  await page.evaluate(async (records) => {
    await customElements.whenDefined('sample-sift');
    // This dynamic import runs in the browser and is served by the Vite test app.
    const { createFixtureDataSource } = await import('/src/data/index.ts');
    for (const element of document.querySelectorAll<SampleSift>('sample-sift')) {
      element.dataSource = createFixtureDataSource(records);
    }
  }, samples);
  const first = page.locator('sample-sift').nth(0);
  const second = page.locator('sample-sift').nth(1);
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(10);
  await expect(second.locator('tbody tr[data-accession]')).toHaveCount(10);
  await expect(first.getByTestId('match-count')).toContainText('24');
  return { first, second };
}

test('two instances keep filters and pagination independent', async ({ page }) => {
  const { first, second } = await openContract(page);

  await first.getByLabel('Biome', { exact: true }).selectOption('Soil');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(8);
  await expect(first.getByTestId('match-count')).toContainText('8');
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-017');
  await expect(second.getByTestId('match-count')).toContainText('24');
  await expect(second.getByLabel('Biome', { exact: true })).toHaveValue('');

  await second.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(second.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-011');
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-017');
  await second.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(second.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-001');
});

test('inclusive date filters show an empty result and can be cleared', async ({ page }) => {
  const { first } = await openContract(page);
  await first.getByLabel('Collected from', { exact: true }).fill('2024-01-17');
  await first.getByLabel('Collected to', { exact: true }).fill('2024-01-17');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(1);
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-017');

  await first.getByLabel('Collected to', { exact: true }).fill('2025-01-01');
  await first.getByLabel('Collected from', { exact: true }).fill('2025-01-01');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(0);
  await expect(first.getByTestId('match-count')).toContainText('0');
  await expect(first.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();

  await first.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(10);
  await expect(first.getByTestId('match-count')).toContainText('24');
});

test('selection searches are scoped to one instance and panning preserves the selected region', async ({ page }) => {
  const { first, second } = await openContract(page);
  await page.evaluate(() => {
    const first = document.querySelector<SampleSift>('sample-sift');
    if (!first) throw new Error('The first SampleSift instance is missing.');
    window.__selectionEvents = [];
    window.__resultsEvents = [];
    document.addEventListener('selectionchange', (event) => {
      window.__selectionEvents.push((event as CustomEvent<SelectionChangeDetail>).detail);
    });
    document.addEventListener('resultschange', (event) => {
      window.__resultsEvents.push((event as CustomEvent<ResultsChangeDetail>).detail);
    });
    first.setSelection({
      type: 'Polygon',
      coordinates: [[[-10, 35], [0, 35], [0, 45], [-10, 45], [-10, 35]]],
    });
  });
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(8);
  await expect(second.getByTestId('match-count')).toContainText('24');
  expect(await page.evaluate(() => window.__selectionEvents.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__resultsEvents.length)).toBe(1);

  const canvas = first.locator('sample-sift-map canvas').first();
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('The sample map has no visible bounds.');
  const x = bounds.x + bounds.width * 0.7;
  const y = bounds.y + bounds.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 70, y + 25, { steps: 8 });
  await page.mouse.up();
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(8);
  expect(await page.evaluate(() => window.__selectionEvents.length)).toBe(0);
  expect(await page.evaluate(() => window.__resultsEvents.length)).toBe(1);

  await first.evaluate((element: SampleSift) => element.clearSelection());
  await expect(first.getByTestId('match-count')).toContainText('24');
  expect(await page.evaluate(() => window.__selectionEvents.length)).toBe(0);
});

test('drawing tools emit one committed polygon event and the Clear tool removes it', async ({ page }) => {
  const { first, second } = await openContract(page);
  const map = first.locator('sample-sift-map');
  const canvas = map.locator('canvas').first();
  await expect(map.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled();
  await canvas.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.__drawEvents = [];
    document.addEventListener('selectionchange', (event) => {
      window.__drawEvents.push((event as CustomEvent<SelectionChangeDetail>).detail);
    });
  });

  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('The sample map has no visible bounds.');
  const at = (x: number, y: number) => ({ x: bounds.width * x, y: bounds.height * y });
  await map.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await canvas.click({ position: at(0.35, 0.35) });
  await canvas.click({ position: at(0.65, 0.7) });
  await expect.poll(() => page.evaluate(() => window.__drawEvents.length)).toBe(1);
  const rectangle = await page.evaluate(() => window.__drawEvents[0].geometry);
  if (!rectangle) throw new Error('The Rectangle tool did not commit a selection.');
  expect(rectangle.type).toBe('Polygon');
  expect(rectangle.coordinates[0]).toHaveLength(5);
  expect(rectangle.coordinates[0][0]).toEqual(rectangle.coordinates[0][4]);
  await expect(second.getByTestId('match-count')).toContainText('24');

  await map.getByRole('button', { name: 'Polygon', exact: true }).click();
  await canvas.click({ position: at(0.35, 0.35) });
  await canvas.click({ position: at(0.65, 0.35) });
  await canvas.click({ position: at(0.55, 0.65) });
  await canvas.click({ position: at(0.35, 0.35) });
  await expect.poll(() => page.evaluate(() => window.__drawEvents.length)).toBe(2);
  const polygon = await page.evaluate(() => window.__drawEvents[1].geometry);
  if (!polygon) throw new Error('The Polygon tool did not commit a selection.');
  expect(polygon.type).toBe('Polygon');
  expect(polygon.coordinates[0]).toHaveLength(4);

  await map.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__drawEvents.length)).toBe(3);
  expect(await page.evaluate(() => window.__drawEvents.at(-1))).toEqual({ geometry: null });
  await expect(first.getByTestId('match-count')).toContainText('24');
});

test('a late response cannot replace newer results even when the data source ignores cancellation', async ({ page }) => {
  const { first } = await openContract(page);
  await first.evaluate((element: SampleSift) => {
    window.__pendingSearches = [];
    element.dataSource = {
      search(query: SearchQuery, options: { signal: AbortSignal }) {
        return new Promise<SearchResult>((resolve) => {
          window.__pendingSearches.push({ query, signal: options.signal, resolve });
        });
      },
    };
  });
  await expect.poll(() => page.evaluate(() => window.__pendingSearches.length)).toBe(1);
  await first.evaluate((element: SampleSift) => element.setFilters({ biome: 'Soil' }));
  await expect.poll(() => page.evaluate(() => window.__pendingSearches.length)).toBe(2);
  expect(await page.evaluate(() => window.__pendingSearches[0].signal.aborted)).toBe(true);

  await page.evaluate((records) => {
    window.__pendingSearches[1].resolve({
      items: [records[16]], total: 1, facets: { biomes: [{ value: 'Soil', count: 1 }] },
    });
  }, samples);
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-017');
  await page.evaluate(async (records) => {
    window.__pendingSearches[0].resolve({
      items: [records[0]], total: 1, facets: { biomes: [{ value: 'Marine', count: 1 }] },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, samples);
  await expect(first.locator('tbody tr').first()).toHaveAttribute('data-accession', 'TEST-017');
  await expect(first.getByLabel('Biome', { exact: true })).toHaveValue('Soil');
});

test('removing and reconnecting an instance preserves state and recreates one usable map', async ({ page }) => {
  const { first } = await openContract(page);
  await first.getByLabel('Biome', { exact: true }).selectOption('Soil');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(8);
  await first.evaluate(async (element) => {
    const marker = document.createComment('sample-sift reconnect position');
    element.before(marker);
    element.remove();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    marker.replaceWith(element);
  });
  await expect(first.getByLabel('Biome', { exact: true })).toHaveValue('Soil');
  await expect(first.locator('sample-sift-map canvas')).toHaveCount(1);
  await first.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(first.getByTestId('match-count')).toContainText('24');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(10);
});

test('map workers load from Vite when embedded on a notebook origin', async ({ page }) => {
  const host = createServer((request, response) => {
    if (request.url?.startsWith('/tiles/')) {
      response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
      response.end(Buffer.alloc(0));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body></body></html>');
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('Missing test host port');
  const origin = `http://127.0.0.1:${address.port}`;
  const wrongOriginRequests: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith(`${origin}/@fs/`)) wrongOriginRequests.push(request.url());
  });
  try {
    await page.goto(origin);
    const preflight = await page.request.fetch('http://127.0.0.1:5173/samplesift/openapi.json', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'QUERY' },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers()['access-control-allow-methods'].split(',')).toContain('QUERY');
    await page.evaluate(async (records) => {
      await import('http://127.0.0.1:5173/src/index.ts');
      const map = document.createElement('sample-sift-map') as HTMLElement & {
        samples: Sample[];
        mapStyle: unknown;
      };
      map.style.height = '420px';
      map.mapStyle = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] };
      map.samples = records;
      document.body.append(map);
    }, samples);
    await expect.poll(() => page.locator('sample-sift-map').evaluate(element => {
      const map = (element as HTMLElement & { _map?: import('maplibre-gl').Map })._map;
      return map?.getSource('samplesift-samples')
        ? map.querySourceFeatures('samplesift-samples').length : 0;
    })).toBeGreaterThan(0);
    await page.evaluate((base) => {
      const events: Array<{ loading: boolean; ready: boolean }> = [];
      (window as Window & { tileEvents: typeof events }).tileEvents = events;
      const map = document.querySelector('sample-sift-map') as HTMLElement & {
        tileSource: import('../src/collection/tiles').CollectionTileSource;
      };
      map.addEventListener('collectiontileschange', event => events.push((event as CustomEvent).detail));
      map.tileSource = { urlTemplate: `${base}/tiles/{z}/{x}/{y}`, sourceLayer: 'occurrences', body: {} };
    }, origin);
    await expect.poll(() => page.evaluate(() => (
      window as Window & { tileEvents: Array<{ loading: boolean }> }
    ).tileEvents.some(event => event.loading))).toBe(true);
    await expect.poll(() => page.evaluate(() => (
      window as Window & { tileEvents: Array<{ ready: boolean }> }
    ).tileEvents.some(event => event.ready))).toBe(true);
    await page.evaluate(() => {
      const form = document.createElement('sample-sift-collection-filter-form') as HTMLElement & {
        metadata: import('../src/collection/types').CollectionMetadata;
      };
      form.metadata = {
        fields: [{ name: 'depth', kind: 'number', nullable: true, operators: ['=', '>=', '<=', 'isNull'] }],
        sortValues: [], defaultLimit: 25, maxLimit: 500, resultColumns: [], queryablesSchema: {}, diagnostics: [],
      };
      document.body.append(form);
    });
    await expect(page.locator('sample-sift-collection-filter-form gui-grid-layout').first()).toBeAttached();
    await expect(page.locator('sample-sift-collection-filter-form').getByRole('button', { name: 'Apply filters', exact: true })).toBeVisible();
    await page.locator('sample-sift-collection-filter-form').getByLabel('Depth: condition', { exact: true }).selectOption('>=');
    await expect(page.locator('sample-sift-collection-filter-form').getByLabel('Depth: value', { exact: true })).toBeVisible();
    await expect(page.locator('sample-sift-collection-filter-form .error[role="alert"]')).toHaveCount(0);
    expect(wrongOriginRequests).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
  }
});
