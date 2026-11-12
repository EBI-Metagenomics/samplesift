import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleFilters, SearchQuery } from '../src/types';
import { EMPTY_FILTERS } from '../src/types';
import { normalizeFilters } from '../src/data/filters';
import { createHttpDataSource } from '../src/data/http';
import {
  applyFilterQueryPatch,
  createFilterQueryPatch,
  readFilterQuery,
  serializeApiFilters,
  type FilterParameterNames,
} from '../src/data/query-params';

const allFilters = (): SampleFilters => normalizeFilters({
  biome: 'Marine & coastal',
  dateFrom: '2020-01-01',
  dateTo: '2024-12-31',
  n50MinBp: 1000,
  n50MaxBp: 90000,
  taxonId: 'ncbi:9606',
  includeDescendants: true,
});
const query = (filters: SampleFilters = allFilters()): SearchQuery => ({
  selection: null, filters, offset: 20, limit: 10,
});
const signal = () => new AbortController().signal;
const stubSearchResponse = () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    items: [], total: 0, facets: { biomes: [] },
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('API filter serialization', () => {
  it('serializes every active field using stable wire names and safe URL encoding', () => {
    const params = serializeApiFilters(allFilters());
    expect([...params]).toEqual([
      ['biome', 'Marine & coastal'], ['date_from', '2020-01-01'], ['date_to', '2024-12-31'],
      ['contig_n50_min', '1000'], ['contig_n50_max', '90000'],
      ['taxon_id', 'ncbi:9606'], ['include_descendants', 'true'],
    ]);
    expect(params.toString()).toContain('biome=Marine+%26+coastal');
    expect(params.toString()).toContain('taxon_id=ncbi%3A9606');
    expect(serializeApiFilters(normalizeFilters({ taxonId: 'custom:alpha+beta&other' })).get('taxon_id')).toBe('custom:alpha+beta&other');
  });

  it('omits null filters and false descendants, retaining a true descendant preference without a selected taxon', () => {
    expect(serializeApiFilters(normalizeFilters({})).toString()).toBe('');
    expect(serializeApiFilters(normalizeFilters({ includeDescendants: true })).toString()).toBe('include_descendants=true');
  });

  it('supports partial field-to-server-name mappings without changing URL-state names', () => {
    const mapping: FilterParameterNames = { n50MinBp: 'n50.min', taxonId: 'taxonomy_id' };
    const params = serializeApiFilters(allFilters(), mapping);
    expect(params.get('n50.min')).toBe('1000');
    expect(params.get('taxonomy_id')).toBe('ncbi:9606');
    expect(params.has('contig_n50_min')).toBe(false);
    expect(params.get('date_from')).toBe('2020-01-01');
    const state = createFilterQueryPatch(allFilters(), { namespace: 'left' });
    expect(state.get('sf.left.contig_n50_min')).toBe('1000');
    expect(state.has('sf.left.n50.min')).toBe(false);
  });

  it.each([
    { biome: '' }, { biome: 'a&b' }, { biome: 'has space' },
    { biome: 'offset' }, { biome: 'limit' }, { biome: 'selection' }, { biome: 'filters' },
    { dateFrom: 'date_to' }, { biome: 'same', taxonId: 'same' },
    { unsupported: 'custom' },
  ])('rejects unsafe, duplicate, reserved or unknown mapping %#', (mapping) => {
    expect(() => serializeApiFilters(allFilters(), mapping as FilterParameterNames)).toThrow();
  });

  it('rejects invalid or unknown state fields rather than silently dropping active predicates', () => {
    expect(() => serializeApiFilters({ ...allFilters(), n50MinBp: Number.NaN })).toThrow();
    expect(() => serializeApiFilters({ ...allFilters(), taxonId: '9606' })).toThrow();
    expect(() => serializeApiFilters({ ...allFilters(), unsupported: 'active' } as SampleFilters)).toThrow('Unsupported filter');
  });
});

describe('routing-independent namespaced state', () => {
  it('round-trips every filter and uses canonical omission for false', () => {
    const params = applyFilterQueryPatch(new URLSearchParams(), createFilterQueryPatch(allFilters(), { namespace: 'left' }));
    expect(readFilterQuery(params, { namespace: 'left' })).toEqual(allFilters());
    const explicitFalse = new URLSearchParams('sf.left.include_descendants=false');
    expect(readFilterQuery(explicitFalse, { namespace: 'left' })).toEqual(EMPTY_FILTERS);
    expect(applyFilterQueryPatch(explicitFalse, createFilterQueryPatch(normalizeFilters({}), { namespace: 'left' })).toString()).toBe('');
  });

  it('merges and clears two namespaces while preserving unrelated keys, future fields and repeated host parameters', () => {
    const original = new URLSearchParams('lang=en&tag=one&tag=two&sf.left.future=keep&sf.left.biome=old&sf.right.taxon_id=ncbi%3A2');
    const left = normalizeFilters({ biome: 'Soil', n50MinBp: 5000 });
    const right = normalizeFilters({ taxonId: 'ncbi:562', includeDescendants: true });
    let latest = applyFilterQueryPatch(original, createFilterQueryPatch(left, { namespace: 'left' }));
    latest = applyFilterQueryPatch(latest, createFilterQueryPatch(right, { namespace: 'right' }));
    expect(readFilterQuery(latest, { namespace: 'left' })).toEqual(left);
    expect(readFilterQuery(latest, { namespace: 'right' })).toEqual(right);
    latest = applyFilterQueryPatch(latest, createFilterQueryPatch(normalizeFilters({}), { namespace: 'left' }));
    expect(readFilterQuery(latest, { namespace: 'left' })).toEqual(EMPTY_FILTERS);
    expect(readFilterQuery(latest, { namespace: 'right' })).toEqual(right);
    expect(latest.getAll('tag')).toEqual(['one', 'two']);
    expect(latest.get('lang')).toBe('en');
    expect(latest.get('sf.left.future')).toBe('keep');
    expect(original.get('sf.left.biome')).toBe('old');
    expect(original.get('sf.right.taxon_id')).toBe('ncbi:2');
  });

  it('lets hosts apply independently prepared patches to their latest state without losing intervening changes', () => {
    const leftPatch = createFilterQueryPatch(normalizeFilters({ biome: 'Marine' }), { namespace: 'left' });
    const rightPatch = createFilterQueryPatch(normalizeFilters({ n50MaxBp: 50000 }), { namespace: 'right' });
    let latest = new URLSearchParams('tab=map');
    latest = applyFilterQueryPatch(latest, leftPatch);
    latest.set('tab', 'table');
    latest.append('tag', 'new-host-value');
    latest = applyFilterQueryPatch(latest, rightPatch);
    expect(latest.get('tab')).toBe('table');
    expect(latest.get('tag')).toBe('new-host-value');
    expect(readFilterQuery(latest, { namespace: 'left' }).biome).toBe('Marine');
    expect(readFilterQuery(latest, { namespace: 'right' }).n50MaxBp).toBe(50000);
  });

  it('reads only exact owned keys and ignores malformed foreign or future parameters', () => {
    const params = new URLSearchParams('sf.left.future=x&sf.left.future=y&sf.leftover.contig_n50_min=invalid&sf.right.taxon_id=invalid&sf.left.biome=Soil');
    expect(readFilterQuery(params, { namespace: 'left' })).toEqual(normalizeFilters({ biome: 'Soil' }));
  });

  it.each(['', 'left.right', 'left right', 'left?x', 'x'.repeat(65)])('rejects unsafe namespace %s', (namespace) => {
    expect(() => createFilterQueryPatch(normalizeFilters({}), { namespace })).toThrow('namespace');
    expect(() => readFilterQuery(new URLSearchParams(), { namespace })).toThrow('namespace');
  });

  it('rejects duplicate owned scalar parameters even when the values agree', () => {
    expect(() => readFilterQuery(new URLSearchParams('sf.left.biome=Soil&sf.left.biome=Soil'), { namespace: 'left' })).toThrow('only once');
    expect(() => readFilterQuery(new URLSearchParams('sf.left.include_descendants=true&sf.left.include_descendants=false'), { namespace: 'left' })).toThrow('only once');
  });

  it.each(['', 'NaN', 'Infinity', '-1', '0', '1.5', '1e3', ' 12', '01', '9007199254740992'])('rejects invalid N50 URL value %s', (value) => {
    const params = new URLSearchParams([['sf.left.contig_n50_min', value]]);
    expect(() => readFilterQuery(params, { namespace: 'left' })).toThrow();
  });

  it.each([
    ['sf.left.date_from', '2023-02-29'],
    ['sf.left.date_to', '2020-01-01T12:00:00'],
    ['sf.left.taxon_id', '9606'],
    ['sf.left.taxon_id', 'ncbi:has whitespace'],
    ['sf.left.include_descendants', '1'],
    ['sf.left.include_descendants', 'TRUE'],
    ['sf.left.biome', ''],
  ])('rejects invalid scalar %s=%s', (key, value) => {
    expect(() => readFilterQuery(new URLSearchParams([[key, value]]), { namespace: 'left' })).toThrow();
  });

  it('rejects inverted date and N50 ranges', () => {
    expect(() => readFilterQuery(new URLSearchParams('sf.left.date_from=2024-01-01&sf.left.date_to=2020-01-01'), { namespace: 'left' })).toThrow('on or before');
    expect(() => readFilterQuery(new URLSearchParams('sf.left.contig_n50_min=10000&sf.left.contig_n50_max=100'), { namespace: 'left' })).toThrow('less than or equal');
  });
});

describe('HTTP filter query transport', () => {
  it('puts filters in the URL, retains configured repeated parameters, strips fragments and sends only geometry/pagination in the body', async () => {
    const fetchMock = stubSearchResponse();
    const source = createHttpDataSource({
      baseUrl: 'https://example.test/api/?tenant=alpha&tag=one&tag=two&biome=stale#ignored',
      filterTransport: 'query',
    });
    const request = query();
    const requestSignal = signal();
    await source.search(request, { signal: requestSignal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/samples/search?');
    expect(url).toContain('biome=Marine+%26+coastal');
    expect(url).not.toContain('#');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('tenant')).toBe('alpha');
    expect(parsed.searchParams.getAll('tag')).toEqual(['one', 'two']);
    expect(parsed.searchParams.getAll('biome')).toEqual(['Marine & coastal']);
    expect(parsed.searchParams.get('taxon_id')).toBe('ncbi:9606');
    expect(JSON.parse(init.body)).toEqual({ selection: null, offset: 20, limit: 10 });
    expect(init.signal).toBe(requestSignal);
    expect(init.method).toBe('POST');
  });

  it('uses only custom mapped keys as filter-owned keys and clears inactive configured mapped values', async () => {
    const fetchMock = stubSearchResponse();
    const mapping: FilterParameterNames = { biome: 'environment', taxonId: 'taxon' };
    const source = createHttpDataSource({
      baseUrl: '/api?environment=old&environment=other&taxon=old&biome=host-owned&contig_n50_min=900&keep=x',
      filterTransport: 'query',
      parameterNames: mapping,
    });
    // Adapter construction captures mapping configuration.
    mapping.biome = 'changed-after-construction';
    await source.search(query(normalizeFilters({ biome: 'Soil' })), { signal: signal() });
    const [url, init] = fetchMock.mock.calls[0];
    const params = new URL(url, 'https://host.test').searchParams;
    expect(params.getAll('environment')).toEqual(['Soil']);
    expect(params.get('biome')).toBe('host-owned');
    expect(params.get('keep')).toBe('x');
    expect(params.has('taxon')).toBe(false);
    expect(params.has('contig_n50_min')).toBe(false);
    expect(params.has('changed-after-construction')).toBe(false);
    expect(JSON.parse(init.body)).not.toHaveProperty('filters');
  });

  it.each([
    ['https://example.test/api?tenant=a#fragment', 'https://example.test/api/samples/search?tenant=a'],
    ['//example.test/api/?tenant=a#fragment', '//example.test/api/samples/search?tenant=a'],
    ['/api/?tenant=a#fragment', '/api/samples/search?tenant=a'],
    ['api?tenant=a#fragment', 'api/samples/search?tenant=a'],
    ['./api?tenant=a#fragment', './api/samples/search?tenant=a'],
    ['../api?tenant=a#fragment', '../api/samples/search?tenant=a'],
    ['?tenant=a#fragment', '/samples/search?tenant=a'],
    ['', '/samples/search'],
  ])('appends the endpoint correctly to %s', async (baseUrl, expectedUrl) => {
    const fetchMock = stubSearchResponse();
    await createHttpDataSource({ baseUrl, filterTransport: 'query' }).search(query(normalizeFilters({})), { signal: signal() });
    expect(fetchMock.mock.calls[0][0]).toBe(expectedUrl);
  });

  it('keeps the complete SearchQuery JSON body by default, including new filters', async () => {
    const fetchMock = stubSearchResponse();
    const request = query();
    await createHttpDataSource({ baseUrl: '/api?tenant=a#fragment' }).search(request, { signal: signal() });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/samples/search?tenant=a');
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it('rejects invalid mappings and unsafe URL schemes before fetching', () => {
    const fetchMock = stubSearchResponse();
    expect(() => createHttpDataSource({ baseUrl: '/api', parameterNames: { n50MinBp: 'offset' } })).toThrow('reserved');
    expect(() => createHttpDataSource({ baseUrl: 'javascript:alert(1)' })).toThrow('HTTP');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates a delayed response against the captured request when the caller changes its query', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn().mockReturnValue(responsePromise);
    vi.stubGlobal('fetch', fetchMock);
    const request = query();
    const pending = createHttpDataSource({ baseUrl: '/api', filterTransport: 'query' }).search(request, { signal: signal() });
    request.limit = 0;
    request.filters.biome = 'Changed after dispatch';
    const result = {
      items: [{ accession: 'DEMO-1', title: 'Synthetic sample', longitude: 5, latitude: 5, biome: 'Marine', collectionDate: null }],
      total: 100,
      facets: { biomes: [{ value: 'Marine', count: 100 }] },
    };
    if (!resolveResponse) throw new Error('Expected the response resolver to be ready.');
    resolveResponse(new Response(JSON.stringify(result), { status: 200 }));
    await expect(pending).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url, 'https://host.test').searchParams.get('biome')).toBe('Marine & coastal');
    expect(JSON.parse(init.body).limit).toBe(10);
  });

  it('preserves already-aborted behavior in query mode', async () => {
    const fetchMock = stubSearchResponse();
    const controller = new AbortController();
    controller.abort();
    await expect(createHttpDataSource({ baseUrl: '/api', filterTransport: 'query' }).search(query(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
