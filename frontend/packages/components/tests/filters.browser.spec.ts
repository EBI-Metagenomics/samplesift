import { expect, test, type Page } from '@playwright/test';
import type { SampleSift } from '../src/components/sample-sift';
import type { FiltersChangeDetail, Sample, SearchQuery, SearchResult } from '../src/types';

const samples: Sample[] = [
  { accession: 'A', title: 'Predicates on different assemblies', longitude: 0, latitude: 0, biome: 'Marine', collectionDate: null,
    assemblies: [
      { accession: 'A1', contigN50Bp: 80000, taxa: [{ id: 'ncbi:287', ancestorIds: ['ncbi:2'] }] },
      { accession: 'A2', contigN50Bp: 10000, taxa: [{ id: 'ncbi:562', ancestorIds: ['ncbi:2', 'ncbi:561'] }] },
    ] },
  { accession: 'B', title: 'Both predicates match', longitude: 1, latitude: 1, biome: 'Marine', collectionDate: null,
    assemblies: [{ accession: 'B1', contigN50Bp: 50000, taxa: [{ id: 'ncbi:562', label: 'Escherichia coli', ancestorIds: ['ncbi:2', 'ncbi:561'] }] }] },
  { accession: 'C', title: 'Unknown N50', longitude: 2, latitude: 2, biome: 'Soil', collectionDate: null,
    assemblies: [{ accession: 'C1', contigN50Bp: null, taxa: [{ id: 'ncbi:562', ancestorIds: ['ncbi:2', 'ncbi:561'] }] }] },
  { accession: 'D', title: 'Parent taxon', longitude: 3, latitude: 3, biome: 'Soil', collectionDate: null,
    assemblies: [{ accession: 'D1', contigN50Bp: 60000, taxa: [{ id: 'ncbi:561', ancestorIds: ['ncbi:2'] }] }] },
];

declare global {
  interface Window {
    __filterChanges: FiltersChangeDetail[];
    __filterRequests: SearchQuery[];
  }
}

async function openFilters(page: Page) {
  await page.goto('/demo/contract.html?tab=results&tag=a&tag=b#/host-route');
  await page.evaluate(async records => {
    await customElements.whenDefined('sample-sift');
    const { createFixtureDataSource } = await import('/src/data/index.ts');
    window.__filterChanges = [];
    window.__filterRequests = [];
    document.addEventListener('filterschange', event => {
      window.__filterChanges.push(structuredClone((event as CustomEvent<FiltersChangeDetail>).detail));
    });
    for (const element of document.querySelectorAll<SampleSift>('sample-sift')) {
      const source = createFixtureDataSource(records);
      element.dataSource = {
        search(query, options) {
          window.__filterRequests.push(structuredClone(query));
          return source.search(query, options);
        },
      };
    }
  }, samples);
  const first = page.locator('#first');
  const second = page.locator('#second');
  await expect(first.getByTestId('match-count')).toHaveText('4 samples');
  await expect(second.getByTestId('match-count')).toHaveText('4 samples');
  return { first, second };
}

test('N50 and taxonomy apply to the same assembly; invalid drafts cannot widen a query or mutate routing', async ({ page }) => {
  const { first, second } = await openFilters(page);
  const before = await page.evaluate(() => {
    history.replaceState({ host: { key: 'keep', scroll: 42 } }, '');
    return { href: location.href, state: history.state, length: history.length };
  });
  await first.getByLabel('Minimum N50 (bp)', { exact: true }).fill('50000');
  await first.getByLabel('Minimum N50 (bp)', { exact: true }).press('Tab');
  await expect(first.getByTestId('match-count')).toHaveText('3 samples');
  await first.getByLabel('Taxonomy ID', { exact: true }).fill('ncbi:562');
  await first.getByLabel('Taxonomy ID', { exact: true }).press('Tab');
  await expect(first.locator('tbody tr[data-accession]')).toHaveCount(1);
  await expect(first.locator('tbody tr')).toHaveAttribute('data-accession', 'B');
  await expect(second.getByTestId('match-count')).toHaveText('4 samples');
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(2);

  const calls = await page.evaluate(() => window.__filterRequests.length);
  await first.getByLabel('Maximum N50 (bp)', { exact: true }).fill('49000');
  await first.getByLabel('Maximum N50 (bp)', { exact: true }).press('Tab');
  await expect(first.getByRole('alert')).toContainText('Minimum N50');
  await first.evaluate(async (element: SampleSift) => { await element.refresh(); await element.updateComplete; });
  expect(await page.evaluate(() => window.__filterRequests.length)).toBe(calls);
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(2);
  await expect(first.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await first.getByLabel('Maximum N50 (bp)', { exact: true }).fill('50000');
  await first.getByLabel('Maximum N50 (bp)', { exact: true }).press('Tab');
  await expect(first.locator('tbody tr')).toHaveAttribute('data-accession', 'B');

  await first.getByLabel('Taxonomy ID', { exact: true }).fill('ncbi:561');
  await first.getByLabel('Taxonomy ID', { exact: true }).press('Tab');
  await expect(first.getByTestId('match-count')).toHaveText('0 samples');
  await first.getByLabel('Include descendant taxa', { exact: true }).check();
  await expect(first.locator('tbody tr')).toHaveAttribute('data-accession', 'B');
  expect(await page.evaluate(() => ({ href: location.href, state: history.state, length: history.length }))).toEqual(before);

  // Host restoration is silent and changes region plus filters in a single request.
  const beforeRestore = await page.evaluate(() => ({ requests: window.__filterRequests.length, events: window.__filterChanges.length }));
  await first.evaluate(async (element: SampleSift) => {
    element.setSearchState({ filters: { n50MinBp: null, n50MaxBp: null, taxonId: null, includeDescendants: false },
      selection: { type: 'Polygon', coordinates: [[[-1, -1], [1.5, -1], [1.5, 1.5], [-1, 1.5], [-1, -1]]] } });
    await element.updateComplete;
  });
  await expect(first.getByTestId('match-count')).toHaveText('2 samples');
  expect(await page.evaluate(() => window.__filterRequests.length)).toBe(beforeRestore.requests + 1);
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(beforeRestore.events);
});

test('api-url sends filter parameters independently of the browser route and emits changes despite API errors', async ({ page }) => {
  const requests: { url: string; body: unknown }[] = [];
  await page.route('**/proof-api/samples/search**', route => {
    requests.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 503, json: { detail: 'Backend unavailable for this test' } });
  });
  await page.goto('/demo/contract.html?tab=overview#details');
  const first = page.locator('#first');
  await first.evaluate((element: SampleSift) => {
    window.__filterChanges = [];
    element.addEventListener('filterschange', event => window.__filterChanges.push((event as CustomEvent<FiltersChangeDetail>).detail));
    element.apiUrl = '/proof-api?project=42';
  });
  await expect(first.getByRole('alert')).toContainText('Backend unavailable');
  const before = page.url();
  await first.getByLabel('Minimum N50 (bp)', { exact: true }).fill('50000');
  await first.getByLabel('Minimum N50 (bp)', { exact: true }).press('Tab');
  await first.getByLabel('Taxonomy ID', { exact: true }).fill('ncbi:562');
  await first.getByLabel('Taxonomy ID', { exact: true }).press('Tab');
  await expect.poll(() => new URL(requests.at(-1)?.url ?? 'https://empty.test').searchParams.get('taxon_id')).toBe('ncbi:562');
  const latest = requests.at(-1);
  if (!latest) throw new Error('Expected an API request');
  const params = new URL(latest.url).searchParams;
  expect(params.get('contig_n50_min')).toBe('50000');
  expect(params.get('project')).toBe('42');
  expect(latest.body).toEqual({ selection: null, offset: 0, limit: 10 });
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(2);
});

test('host-controlled URL sync preserves foreign state and two namespaces through Back and Forward', async ({ page }) => {
  await page.goto('/demo/url-state.html?tab=results&tag=a&tag=b&sf.left.future=keep#/host-route');
  const left = page.locator('#left');
  const right = page.locator('#right');
  await expect(left.getByTestId('match-count')).toHaveText('120 samples');
  await expect(right.getByTestId('match-count')).toHaveText('120 samples');
  await expect(left.getByLabel('Biome', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    history.replaceState({ hostRouter: { key: 'preserve' } }, '');
    window.__filterChanges = [];
    document.addEventListener('filterschange', event => window.__filterChanges.push((event as CustomEvent<FiltersChangeDetail>).detail));
  });
  await left.getByLabel('Minimum N50 (bp)', { exact: true }).fill('50000');
  await left.getByLabel('Minimum N50 (bp)', { exact: true }).press('Tab');
  await expect.poll(() => new URL(page.url()).searchParams.get('sf.left.contig_n50_min')).toBe('50000');
  await right.getByLabel('Taxonomy ID', { exact: true }).fill('ncbi:562');
  await right.getByLabel('Taxonomy ID', { exact: true }).press('Tab');
  await expect.poll(() => new URL(page.url()).searchParams.get('sf.right.taxon_id')).toBe('ncbi:562');
  await page.getByLabel('Host application tab').selectOption('overview');
  const params = new URL(page.url()).searchParams;
  expect(params.getAll('tag')).toEqual(['a', 'b']);
  expect(params.get('sf.left.future')).toBe('keep');
  expect(params.get('sf.left.contig_n50_min')).toBe('50000');
  expect(new URL(page.url()).hash).toBe('#/host-route');
  expect(await page.evaluate(() => history.state)).toEqual({ hostRouter: { key: 'preserve' } });

  await page.goBack();
  await expect(page.getByLabel('Host application tab')).toHaveValue('results');
  await expect(right.getByLabel('Taxonomy ID', { exact: true })).toHaveValue('ncbi:562');
  await page.goBack();
  await expect(right.getByLabel('Taxonomy ID', { exact: true })).toHaveValue('');
  await expect(left.getByLabel('Minimum N50 (bp)', { exact: true })).toHaveValue('50000');
  await page.goForward();
  await expect(right.getByLabel('Taxonomy ID', { exact: true })).toHaveValue('ncbi:562');
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(2);
  await left.getByRole('button', { name: 'Clear filters', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('sf.left.contig_n50_min')).toBe(false);
  expect(new URL(page.url()).searchParams.get('sf.right.taxon_id')).toBe('ncbi:562');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['a', 'b']);
});

test('malformed URL constraints produce a host error and do not issue a broader demo search', async ({ page }) => {
  await page.goto('/demo/url-state.html?sf.left.contig_n50_min=wrong');
  await expect(page.locator('#route-error')).toContainText('Cannot restore these filters');
  await expect(page.locator('#left').getByTestId('match-count')).toHaveText('No data source');
  await expect(page.locator('#right').getByTestId('match-count')).toHaveText('No data source');
  await expect(page.locator('tbody tr')).toHaveCount(0);
});

test('invalid direct state is rejected before a custom source runs, and event data cannot mutate retained evidence', async ({ page }) => {
  const { first } = await openFilters(page);
  await first.evaluate((element: SampleSift) => {
    element.addEventListener('resultschange', event => {
      const result = (event as CustomEvent<{ result: SearchResult }>).detail.result;
      const assembly = result.items[0]?.assemblies?.[0];
      if (assembly) assembly.contigN50Bp = 999;
    });
    element.setFilters({ taxonId: 'ncbi:562', n50MinBp: 50000 });
  });
  await expect(first.locator('tbody tr')).toHaveAttribute('data-accession', 'B');
  await first.locator('tbody details summary').click();
  await expect(first.locator('tbody')).toContainText('50,000');
  await expect(first.locator('tbody')).not.toContainText('999');
  const count = await page.evaluate(() => window.__filterRequests.length);
  await first.evaluate(async (element: SampleSift) => {
    element.filters = { ...element.filters, n50MinBp: Number.NaN };
    await element.updateComplete;
  });
  await expect(first.getByRole('alert')).toContainText('positive integer');
  expect(await page.evaluate(() => window.__filterRequests.length)).toBe(count);
});


test('Clear filters recovers from unsupported programmatic state and emits one clean reset', async ({ page }) => {
  const { first } = await openFilters(page);
  await first.evaluate(async (element: SampleSift) => {
    element.filters = Object.assign({}, element.filters, { depthMin: 10 });
    await element.updateComplete;
  });
  await expect(first.getByRole('alert')).toContainText('Unsupported filter: depthMin');
  await first.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(first.getByTestId('match-count')).toHaveText('4 samples');
  expect(await page.evaluate(() => window.__filterChanges.length)).toBe(1);
  expect(await page.evaluate(() => Object.hasOwn(window.__filterChanges[0].filters, 'depthMin'))).toBe(false);
});
