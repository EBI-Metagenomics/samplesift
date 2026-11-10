import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import type { Sample, SearchQuery, SearchResult } from '../src/types';
import { EMPTY_FILTERS } from '../src/types';
import { createDemoSamples, createFixtureDataSource, createHttpDataSource, validatePolygon } from '../src/data';

const square: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const sample = (accession: string, overrides: Partial<Sample> = {}): Sample => ({
  accession, title: `Sample ${accession}`, longitude: 5, latitude: 5,
  biome: 'Marine', collectionDate: '2020-06-01', ...overrides,
});
const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  selection: null, filters: { ...EMPTY_FILTERS, biome: null, dateFrom: null, dateTo: null }, offset: 0, limit: 20, ...overrides,
});
const options = () => ({ signal: new AbortController().signal });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('fixture data source', () => {
  const samples = [
    sample('D', { longitude: 0, latitude: 5, collectionDate: null }),
    sample('B', { biome: 'Soil' }),
    sample('A', { longitude: 0, latitude: 0, collectionDate: '2020-01-01' }),
    sample('E', { longitude: 25, latitude: 30, biome: 'Freshwater' }),
    sample('C', { collectionDate: '2020-12-31' }),
  ];

  it('includes edge and vertex points, sorts by accession, and paginates without changing totals or facets', async () => {
    const source = createFixtureDataSource(samples);
    const result = await source.search(query({ selection: square, offset: 1, limit: 2 }), options());
    expect(result.items.map(({ accession }) => accession)).toEqual(['B', 'C']);
    expect(result.total).toBe(4);
    expect(result.facets.biomes).toEqual([{ value: 'Marine', count: 3 }, { value: 'Soil', count: 1 }]);
    const all = await source.search(query({ selection: square }), options());
    expect(all.items.map(({ accession }) => accession)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('ANDs spatial, biome and inclusive date ranges and excludes unknown dates when a range is active', async () => {
    const source = createFixtureDataSource(samples);
    const result = await source.search(query({
      selection: square, filters: { ...EMPTY_FILTERS, biome: 'Marine', dateFrom: '2020-01-01', dateTo: '2020-12-31' },
    }), options());
    expect(result.items.map(({ accession }) => accession)).toEqual(['A', 'C']);
    expect(result.facets.biomes).toEqual([{ value: 'Marine', count: 2 }]);
    const lowerBound = await source.search(query({ filters: { ...EMPTY_FILTERS, biome: null, dateFrom: '2020-06-01', dateTo: null } }), options());
    expect(lowerBound.items.map(({ accession }) => accession)).toEqual(['B', 'C', 'E']);
    const upperBound = await source.search(query({ filters: { ...EMPTY_FILTERS, biome: null, dateFrom: null, dateTo: '2020-01-01' } }), options());
    expect(upperBound.items.map(({ accession }) => accession)).toEqual(['A']);
  });

  it('returns null-date samples without a date range, and empty pages retain totals and facets', async () => {
    const source = createFixtureDataSource(samples);
    const all = await source.search(query(), options());
    expect(all.items.some(({ accession }) => accession === 'D')).toBe(true);
    const beyondEnd = await source.search(query({ offset: 100 }), options());
    expect(beyondEnd.items).toEqual([]);
    expect(beyondEnd.total).toBe(all.total);
    expect(beyondEnd.facets).toEqual(all.facets);
  });

  it('rejects invalid dates, inverted ranges, fractional pagination and invalid coordinates', async () => {
    const source = createFixtureDataSource(samples);
    await expect(source.search(query({ filters: { ...EMPTY_FILTERS, biome: null, dateFrom: '2023-02-29', dateTo: null } }), options())).rejects.toThrow('valid YYYY-MM-DD');
    await expect(source.search(query({ filters: { ...EMPTY_FILTERS, biome: null, dateFrom: '2021-01-01', dateTo: '2020-01-01' } }), options())).rejects.toThrow('on or before');
    await expect(source.search(query({ offset: 0.5 }), options())).rejects.toThrow('offset');
    await expect(source.search(query({ limit: 0 }), options())).rejects.toThrow('limit');
    expect(() => createFixtureDataSource([sample('bad', { longitude: 181 })])).toThrow('valid coordinates');
    expect(() => createFixtureDataSource([sample('same'), sample('same')])).toThrow('Duplicate');
  });

  it('rejects an already-aborted search without waiting', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const source = createFixtureDataSource(samples, { latencyMs: 500 });
    await expect(source.search(query(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels delayed searches immediately and removes the pending timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const source = createFixtureDataSource(samples, { latencyMs: 500 });
    const pending = source.search(query(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures a delayed query and isolates results from mutation', async () => {
    vi.useFakeTimers();
    const source = createFixtureDataSource(samples, { latencyMs: 50 });
    const request = query({ filters: { ...EMPTY_FILTERS, biome: 'Soil', dateFrom: null, dateTo: null } });
    const pending = source.search(request, options());
    request.filters.biome = 'Marine';
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.items.map(({ accession }) => accession)).toEqual(['B']);
    const firstItem = result.items[0];
    if (!firstItem) throw new Error('Expected the matching Soil sample.');
    firstItem.title = 'Changed by caller';
    const next = source.search(query(), options());
    await vi.advanceTimersByTimeAsync(50);
    expect((await next).items.find(({ accession }) => accession === 'B')?.title).toBe('Sample B');
  });
});

describe('polygon validation', () => {
  it('accepts a simple concave polygon and excludes a point in its cutout', async () => {
    const concave: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [2, 2], [0, 4], [0, 0]]] };
    expect(() => validatePolygon(concave)).not.toThrow();
    const source = createFixtureDataSource([sample('inside', { longitude: 2, latitude: 1 }), sample('outside', { longitude: 2, latitude: 3 })]);
    const result = await source.search(query({ selection: concave }), options());
    expect(result.items.map(({ accession }) => accession)).toEqual(['inside']);
  });

  it.each([
    ['unclosed', [[[0, 0], [4, 0], [4, 4], [0, 4]]]],
    ['crossing', [[[0, 0], [4, 4], [4, 0], [0, 4], [0, 0]]]],
    ['holes', square.coordinates.concat([[[2, 2], [3, 2], [3, 3], [2, 2]]])],
    ['invalid coordinates', [[[0, 0], [200, 0], [0, 4], [0, 0]]]],
    ['zero area', [[[0, 0], [1, 0], [2, 0], [0, 0]]]],
    ['antimeridian crossing', [[[170, 0], [-170, 0], [-170, 5], [170, 0]]]],
  ])('rejects %s polygons', (_, coordinates) => {
    expect(() => validatePolygon({ type: 'Polygon', coordinates })).toThrow();
  });
});

describe('HTTP data source', () => {
  const result: SearchResult = { items: [sample('A')], total: 1, facets: { biomes: [{ value: 'Marine', count: 1 }] } };

  it('posts the exact query and AbortSignal to the normalized endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = createHttpDataSource({ baseUrl: 'https://example.test/api/' });
    const request = query({ selection: square });
    const requestOptions = options();
    await expect(source.search(request, requestOptions)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/samples/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request), signal: requestOptions.signal,
    });
  });

  it('reports non-OK HTTP status and the server explanation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Selection exceeds allowed area.' }), { status: 422 })));
    await expect(createHttpDataSource({ baseUrl: '/api' }).search(query(), options())).rejects.toThrow('HTTP 422): Selection exceeds allowed area.');
  });

  it.each([
    { ...result, total: -1 },
    { ...result, total: 1.5 },
    { ...result, items: [sample('A', { latitude: 91 })] },
    { ...result, items: [sample('A', { collectionDate: '2020-02-31' })] },
    { ...result, items: [sample('A', { sourceUrl: 'javascript:alert(1)' })] },
    { ...result, facets: { biomes: [{ value: 'Marine', count: -1 }] } },
    { ...result, facets: { biomes: [{ value: 'Marine', count: 2 }] } },
    { ...result, total: 2, items: [sample('A'), sample('A')] },
  ])('rejects malformed response %#', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(createHttpDataSource({ baseUrl: '/api' }).search(query(), options())).rejects.toThrow('Invalid search response');
  });

  it('rejects a successful response containing non-JSON content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Unexpected proxy response</html>', { status: 200 })));
    await expect(createHttpDataSource({ baseUrl: '/api' }).search(query(), options())).rejects.toThrow('expected JSON');
  });

  it('does not fetch when already aborted and propagates cancellation from fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    const source = createHttpDataSource({ baseUrl: '/api' });
    const controller = new AbortController();
    controller.abort();
    await expect(source.search(query(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(source.search(query(), options())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('synthetic demo data', () => {
  it('is deterministic, explicitly synthetic and covers multiple biomes and unknown dates', () => {
    const records = createDemoSamples();
    expect(records).toEqual(createDemoSamples());
    expect(records).toHaveLength(120);
    expect(new Set(records.map(({ accession }) => accession)).size).toBe(120);
    expect(records.every(({ accession, sourceUrl, title }) => accession.startsWith('DEMO-') && sourceUrl === undefined && title.includes('synthetic'))).toBe(true);
    expect(new Set(records.map(({ biome }) => biome))).toEqual(new Set(['Marine', 'Soil', 'Freshwater']));
    expect(records.some(({ collectionDate }) => collectionDate === null)).toBe(true);
    expect(() => createFixtureDataSource(records)).not.toThrow();
  });
});
