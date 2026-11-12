import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import type { CollectionQuery, CollectionSearchState, Predicate } from '../src/collection/types';
import {
  applyCollectionQueryPatch, buildCollectionQuery, compileCollectionFilter, createCollectionDataSource,
  createCollectionQueryPatch, parseCollectionMetadata, readCollectionQuery, validateCollectionQuery, validateCollectionState,
} from '../src/collection';

const allOps = ['=', '<>', 'in', 'isNull', '>', '>=', '<', '<='];
const field = (type: string | string[], operators = allOps, extra: Record<string, unknown> = {}) => ({ type, 'x-samplesift': { operators }, ...extra });
function queryables(geometry = true, overrides: Record<string, unknown> = {}) {
  return {
    type: 'object',
    properties: {
      lon: field('number'), lat: field('number'), depth: field('number'),
      date: field('string', allOps, { format: 'date' }),
      name: field('string', ['=', '<>', 'in', 'isNull']),
      ...(geometry ? { geometry: field('object', ['s_intersects'], { description: 'GeoJSON Point in EPSG:4326.' }) } : {}),
      ...overrides,
    },
    additionalProperties: false,
  };
}
function openapi() {
  return {
    openapi: '3.2.1',
    paths: {
      '/samplesift/collections/occurrences/results': {
        query: {
          'x-samplesift-queryables': '/samplesift/collections/occurrences/queryables',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Request' } } } },
          responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Result' } } } } } } } },
        },
      },
    },
    components: { schemas: {
      Request: { type: 'object', properties: {
        filter: { type: 'object' },
        sort: { type: 'array', items: { type: 'string', enum: ['name', '-name', 'depth', '-depth', 'date', '-date'] } },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        offset: { type: 'integer', minimum: 0 },
      } },
      Result: { type: 'object', properties: { source_pk: { type: 'string' }, geometry: { type: ['object', 'null'] }, depth: { type: 'number', title: 'Depth' }, name: { type: 'string' } } },
    } },
  };
}
const metadata = (geometry = true, overrides: Record<string, unknown> = {}) => parseCollectionMetadata(queryables(geometry, overrides), openapi(), { collection: 'occurrences' });
const state = (predicates: Predicate[] = [], overrides: Partial<CollectionSearchState> = {}): CollectionSearchState => ({ predicates, sort: [], selection: null, ...overrides });
const rectangle: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const triangle: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [5, 10], [0, 0]]] };
const spatial = { longitudeField: 'lon', latitudeField: 'lat' };
const signal = () => new AbortController().signal;
const row = () => ({ source_pk: '1', geometry: { type: 'Point', coordinates: [5, 6] }, name: 'Raw collection name', depth: 52.5, extra: { source: 'kept' } });
afterEach(() => vi.unstubAllGlobals());

describe('collection metadata', () => {
  it('reads QUERY models, preserves metadata and treats advertised geometry as a spatial capability', () => {
    const model = metadata();
    expect(model.fields.map(item => item.name)).toEqual(['lon', 'lat', 'depth', 'date', 'name']);
    expect(model.geometryField).toBe('geometry');
    expect(model.fields.find(item => item.name === 'date')?.kind).toBe('date');
    expect(model.sortValues).toEqual(['name', '-name', 'depth', '-depth', 'date', '-date']);
    expect(model.defaultLimit).toBe(100);
    expect(model.maxLimit).toBe(500);
    expect(model.resultColumns).toContainEqual({ name: 'depth', title: 'Depth' });
    expect(model.queryablesSchema).toEqual(queryables());
    expect(model.diagnostics).toEqual([]);
  });

  it('reports unsupported operators and constraints instead of silently enabling them', () => {
    const model = metadata(true, {
      name: field('string', ['=', 'like']),
      complex: { anyOf: [{ type: 'string' }, { type: 'number' }], 'x-samplesift': { operators: ['='] } },
      timestamp: field('string', ['='], { format: 'date-time' }),
    });
    expect(model.fields.find(item => item.name === 'name')?.operators).toEqual(['=']);
    expect(model.fields.some(item => item.name === 'complex' || item.name === 'timestamp')).toBe(false);
    expect(model.diagnostics.join(' ')).toContain('unsupported operator like');
    expect(model.diagnostics.join(' ')).toContain('anyOf');
    expect(model.diagnostics.join(' ')).toContain('date-time');
    expect(() => validateCollectionState(state([{ field: 'complex', operator: '=', value: 'x' }]), model)).toThrow('unsupported');
  });

  it('rejects ambiguous geometry properties and ambiguous results operations', () => {
    expect(() => metadata(true, { otherGeometry: field('object', ['s_intersects']) })).toThrow('ambiguous');
    const api = openapi();
    Object.assign(api.paths, { '/another/collections/occurrences/results': api.paths['/samplesift/collections/occurrences/results'] });
    expect(() => parseCollectionMetadata(queryables(), api, { collection: 'occurrences' })).toThrow('exactly one');
  });

  it('supports nullable primitives, integer enums and booleans with declared operators', () => {
    const model = metadata(false, {
      category: field(['integer', 'null'], ['=', 'in', 'isNull'], { enum: [1, 2, null] }),
      enabled: field('boolean', ['=', 'in', 'isNull', '>']),
    });
    expect(model.fields.find(item => item.name === 'category')).toMatchObject({ kind: 'integer', nullable: true });
    expect(model.fields.find(item => item.name === 'enabled')?.operators).toEqual(['=', 'in', 'isNull']);
    expect(model.diagnostics.join(' ')).toContain('ordered boolean');
    expect(() => validateCollectionState(state([{ field: 'category', operator: '=', value: 1.5 }]), model)).toThrow();
    expect(() => validateCollectionState(state([{ field: 'category', operator: '=', value: 3 }]), model)).toThrow('enum');
    expect(() => validateCollectionState(state([{ field: 'enabled', operator: '=', value: true }]), model)).not.toThrow();
  });
});

describe('typed CQL2 compilation', () => {
  it('compiles scalar ranges, canonical date literals, in lists and unary null checks', () => {
    const compiled = compileCollectionFilter(state([
      { field: 'depth', operator: '>=', value: 50.5 },
      { field: 'depth', operator: '<=', value: 90 },
      { field: 'date', operator: 'in', value: ['2020-02-29', '2024-01-01'] },
      { field: 'name', operator: 'isNull' },
    ]), metadata());
    expect(compiled).toEqual({ op: 'and', args: [
      { op: '>=', args: [{ property: 'depth' }, 50.5] },
      { op: '<=', args: [{ property: 'depth' }, 90] },
      { op: 'in', args: [{ property: 'date' }, [{ date: '2020-02-29' }, { date: '2024-01-01' }]] },
      { op: 'isNull', args: [{ property: 'name' }] },
    ] });
    expect(compileCollectionFilter(state(), metadata())).toBeUndefined();
  });

  it('enforces declared numeric and string constraints', () => {
    const model = metadata(false, {
      depth: field('number', allOps, { minimum: 0, maximum: 100, exclusiveMaximum: 90, multipleOf: 0.5 }),
      name: field('string', ['=', 'in'], { minLength: 2, maxLength: 5, pattern: '^[A-Z]+$' }),
    });
    expect(() => validateCollectionState(state([{ field: 'depth', operator: '>=', value: 50.5 }, { field: 'name', operator: '=', value: 'ABC' }]), model)).not.toThrow();
    for (const value of [-1, 90, 101, 50.25]) expect(() => validateCollectionState(state([{ field: 'depth', operator: '=', value }]), model)).toThrow();
    for (const value of ['A', 'ABCDEF', 'lower']) expect(() => validateCollectionState(state([{ field: 'name', operator: '=', value }]), model)).toThrow();
  });

  it('rejects wrong types, invalid dates, empty lists, unknown fields and unadvertised operators', () => {
    const invalid = [
      { field: 'depth', operator: '=', value: '12' },
      { field: 'date', operator: '=', value: '2023-02-29' },
      { field: 'depth', operator: 'in', value: [] },
      { field: 'absent', operator: '=', value: 1 },
      { field: 'name', operator: '>', value: 'A' },
    ] as Predicate[];
    for (const predicate of invalid) expect(() => validateCollectionState(state([predicate]), metadata())).toThrow();
    expect(() => validateCollectionState({ ...state(), unsupported: 'active' }, metadata())).toThrow('Unsupported');
  });

  it('uses advertised geometry for arbitrary valid polygons and combines it with scalar predicates', () => {
    const compiled = compileCollectionFilter(state([{ field: 'depth', operator: '>=', value: 50 }], { selection: triangle }), metadata());
    expect(compiled).toEqual({ op: 'and', args: [
      { op: '>=', args: [{ property: 'depth' }, 50] },
      { op: 's_intersects', args: [{ property: 'geometry' }, triangle] },
    ] });
    expect(() => validateCollectionQuery({ filter: compiled }, metadata())).not.toThrow();
  });

  it('supports inclusive rectangle fallback only with explicit numeric coordinate capabilities', () => {
    const model = metadata(false);
    expect(compileCollectionFilter(state([], { selection: rectangle }), model, spatial)).toEqual({ op: 'and', args: [
      { op: '>=', args: [{ property: 'lon' }, 0] }, { op: '<=', args: [{ property: 'lon' }, 10] },
      { op: '>=', args: [{ property: 'lat' }, 0] }, { op: '<=', args: [{ property: 'lat' }, 10] },
    ] });
    expect(() => compileCollectionFilter(state([], { selection: triangle }), model, spatial)).toThrow('axis-aligned');
    expect(() => compileCollectionFilter(state([], { selection: rectangle }), model)).toThrow('mapping');
    expect(() => compileCollectionFilter(state([], { selection: rectangle }), metadata(false, { lon: field('number', ['=']) }), spatial)).toThrow('advertise');
  });

  it('validates sort capability, conflicting sorts and pagination against request metadata', () => {
    expect(buildCollectionQuery(state([], { sort: ['-depth', 'name'] }), metadata(), { limit: 30, offset: 60 })).toEqual({ sort: ['-depth', 'name'], limit: 30, offset: 60 });
    expect(() => buildCollectionQuery(state([], { sort: ['lon'] }), metadata(), { limit: 10, offset: 0 })).toThrow('sort');
    expect(() => buildCollectionQuery(state([], { sort: ['depth', '-depth'] }), metadata(), { limit: 10, offset: 0 })).toThrow('conflicting');
    expect(() => buildCollectionQuery(state(), metadata(), { limit: 501, offset: 0 })).toThrow('limit');
    expect(() => buildCollectionQuery(state(), metadata(), { limit: 10, offset: -1 })).toThrow('offset');
    expect(() => validateCollectionQuery({ limit: null }, metadata())).toThrow('limit');
    expect(() => validateCollectionQuery({ offset: null }, metadata())).toThrow('offset');
  });

  it('rejects unsupported raw CQL2 rather than forwarding an ignored or broader query', () => {
    expect(() => validateCollectionQuery({ filter: { op: 'like', args: [{ property: 'name' }, '*'] } }, metadata())).toThrow('Unsupported CQL2');
    expect(() => validateCollectionQuery({ filter: { op: '=', args: [{ property: 'date' }, '2020-01-01'] } }, metadata())).toThrow('date literal');
    expect(() => validateCollectionQuery({ filter: { op: 's_intersects', args: [{ property: 'wrong' }, rectangle] } }, metadata())).toThrow('advertised');
    expect(() => validateCollectionQuery({ filter: { op: 'and', args: [] } }, metadata())).toThrow('at least one');
  });
});

describe('host-owned collection URL state', () => {
  it('round-trips predicates, sort order and polygon while preserving other namespaces and repeated host keys', () => {
    const original = new URLSearchParams('tab=results&tag=a&tag=b&sf.left.future=keep');
    const left = state([{ field: 'name', operator: 'in', value: ['A & B', 'C+D'] }], { sort: ['-depth', 'name'], selection: triangle });
    const right = state([{ field: 'depth', operator: '>=', value: 10 }]);
    let latest = applyCollectionQueryPatch(original, createCollectionQueryPatch(left, { namespace: 'left' }));
    latest.set('tab', 'map');
    latest = applyCollectionQueryPatch(latest, createCollectionQueryPatch(right, { namespace: 'right' }));
    expect(readCollectionQuery(latest, metadata(), { namespace: 'left' })).toEqual(left);
    expect(readCollectionQuery(latest, metadata(), { namespace: 'right' })).toEqual(right);
    expect(latest.getAll('tag')).toEqual(['a', 'b']);
    expect(latest.get('tab')).toBe('map');
    expect(latest.get('sf.left.future')).toBe('keep');
    latest = applyCollectionQueryPatch(latest, createCollectionQueryPatch(state(), { namespace: 'left' }));
    expect(latest.has('sf.left.query')).toBe(false);
    expect(readCollectionQuery(latest, metadata(), { namespace: 'right' })).toEqual(right);
    expect(original.has('sf.left.query')).toBe(false);
  });

  it('rejects malformed, duplicate, future-version and stale unsupported constraints', () => {
    const params = applyCollectionQueryPatch(new URLSearchParams(), createCollectionQueryPatch(state([{ field: 'depth', operator: '>', value: 5 }]), { namespace: 'one' }));
    const stale = metadata();
    stale.fields = stale.fields.filter(field => field.name !== 'depth');
    expect(() => readCollectionQuery(params, stale, { namespace: 'one' })).toThrow('unsupported');
    const duplicate = new URLSearchParams(params);
    duplicate.append('sf.one.query', params.get('sf.one.query') ?? '');
    expect(() => readCollectionQuery(duplicate, metadata(), { namespace: 'one' })).toThrow('only once');
    for (const payload of ['not json', JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, ...state(), ignored: true })]) {
      expect(() => readCollectionQuery(new URLSearchParams([['sf.one.query', payload]]), metadata(), { namespace: 'one' })).toThrow();
    }
    expect(() => createCollectionQueryPatch(state([{ field: 'depth', operator: '=', value: Number.NaN }]), { namespace: 'one' })).toThrow();
    expect(() => createCollectionQueryPatch(state(), { namespace: 'one.two' })).toThrow('namespace');
  });
});

describe('collection HTTP adapter', () => {
  function mockBackend(result: unknown = { items: [row()], total: 4, limit: 10, offset: 0 }) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/queryables')) return new Response(JSON.stringify(queryables()), { status: 200 });
      if (url.includes('/openapi.json')) return new Response(JSON.stringify(openapi()), { status: 200 });
      if (init.method === 'QUERY') return new Response(JSON.stringify(result), { status: 200 });
      throw new Error('Unexpected URL');
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('loads/caches isolated metadata, preserves API-root parameters, and uses QUERY with raw rows', async () => {
    const fetchMock = mockBackend();
    const source = createCollectionDataSource({ baseUrl: 'https://example.test/prefix/samplesift/?tenant=a&tag=x&tag=y#drop', collection: 'occurrences' });
    const requestSignal = signal();
    const model = await source.metadata({ signal: requestSignal });
    model.fields[0].operators.length = 0;
    const another = await source.metadata({ signal: requestSignal });
    expect(another.fields[0].operators.length).toBeGreaterThan(0);
    const request = buildCollectionQuery(state([{ field: 'depth', operator: '>=', value: 50.5 }]), another, { limit: 10, offset: 0 });
    const result = await source.search(request, { signal: requestSignal });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe('https://example.test/prefix/samplesift/collections/occurrences/results?tenant=a&tag=x&tag=y');
    expect(init.method).toBe('QUERY');
    expect(init.signal).toBe(requestSignal);
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(result.items[0]).toEqual(row());
    expect(result.total).toBe(4);
    expect(source.tileUrlTemplate).toBe('https://example.test/prefix/samplesift/collections/occurrences/tiles/{z}/{x}/{y}?tenant=a&tag=x&tag=y');
  });

  it('snapshots the query before asynchronous metadata loading', async () => {
    const fetchMock = mockBackend({ items: [row()], total: 1 });
    const source = createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' });
    const request: CollectionQuery = { filter: { op: '>=', args: [{ property: 'depth' }, 50] }, limit: 10, offset: 0 };
    const pending = source.search(request, { signal: signal() });
    request.limit = 0;
    if (request.filter) request.filter.args[1] = 100;
    const result = await pending;
    const call = fetchMock.mock.calls.find(([, init]) => init.method === 'QUERY');
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1].body))).toEqual({ filter: { op: '>=', args: [{ property: 'depth' }, 50] }, limit: 10, offset: 0 });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it('keeps missing total unknown and accepts geometryless rows without inventing sample fields', async () => {
    mockBackend({ items: [{ source_pk: 'x', geometry: null, custom: 42 }], next_cursor: 'abc' });
    const result = await createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' }).search({ limit: 5 }, { signal: signal() });
    expect(result.total).toBeUndefined();
    expect(result.items).toEqual([{ source_pk: 'x', geometry: null, custom: 42 }]);
    expect(result.limit).toBe(5);
    expect(result.offset).toBe(0);
    expect(result.nextCursor).toBe('abc');
  });

  it.each([
    { items: [{ source_pk: '1', geometry: { type: 'Point', coordinates: [200, 0] } }] },
    { items: [{ source_pk: '1' }] },
    { items: [row(), row()] },
    { items: [row()], total: -1 },
    { items: [], limit: 0 },
    { items: [], offset: 0.5 },
    { items: [row()], total: 1, offset: 10 },
    { items: [], next_cursor: 1 },
  ])('rejects malformed response %#', async result => {
    mockBackend(result);
    await expect(createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' }).search({ limit: 10 }, { signal: signal() })).rejects.toThrow();
  });

  it('preserves cancellation before metadata, during metadata and when metadata is cached', async () => {
    const fetchMock = mockBackend();
    const source = createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' });
    const controller = new AbortController();
    controller.abort();
    await expect(source.metadata({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(source.search({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await source.metadata({ signal: signal() });
    await expect(source.metadata({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    fetchMock.mockImplementation(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(source.search({}, { signal: signal() })).rejects.toMatchObject({ name: 'AbortError' });
    const uncached = createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' });
    await expect(uncached.metadata({ signal: signal() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports HTTP failures and does not cache unsuccessful metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: 'Collection unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = createCollectionDataSource({ baseUrl: '/samplesift', collection: 'occurrences' });
    await expect(source.metadata({ signal: signal() })).rejects.toThrow('HTTP 503): Collection unavailable');
    const healthy = mockBackend();
    await expect(source.metadata({ signal: signal() })).resolves.toHaveProperty('geometryField', 'geometry');
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});
