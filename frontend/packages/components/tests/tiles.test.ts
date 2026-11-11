import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollectionTileLoader } from '../src/collection/tiles';
import type { CollectionTileSource, CollectionTileStatus, TileSourceRevision } from '../src/collection/tiles';

const source = (overrides: Partial<CollectionTileSource> = {}): CollectionTileSource => ({
  urlTemplate: '/api/collections/occurrences/tiles/{z}/{x}/{y}',
  sourceLayer: 'occurrences',
  body: { filter: { op: '>=', args: [{ property: 'depth' }, 50] } },
  ...overrides,
});
const tileUrl = (revision: TileSourceRevision, x = 2053) => revision.urlTemplate
  .replace('{z}', '12').replace('{x}', String(x)).replace('{y}', '1314');
const response = () => new Response(new Uint8Array([1, 2, 3]), {
  headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile' },
});
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise was not initialized.'); };
  let reject: (reason: Error) => void = () => { throw new Error('Deferred promise was not initialized.'); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('collection QUERY tile loader', () => {
  it('posts an immutable body snapshot and returns an ArrayBuffer', async () => {
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValue(response());
    const body = { filter: { op: '>=', args: [{ property: 'depth' }, 50] } };
    const configuration = source({ body });
    const loader = createCollectionTileLoader('test-tiles', fetchTile);
    const revision = loader.setSource(configuration);
    body.filter.args[1] = 999;
    configuration.urlTemplate = 'https://changed.test/{z}/{x}/{y}';
    configuration.sourceLayer = 'changed';
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await loader.load({ url: tileUrl(revision) }, controller);
    expect(revision.sourceLayer).toBe('occurrences');
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchTile).toHaveBeenCalledWith('/api/collections/occurrences/tiles/12/2053/1314', {
      method: 'QUERY',
      headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.mapbox-vector-tile' },
      body: JSON.stringify({ filter: { op: '>=', args: [{ property: 'depth' }, 50] } }),
      signal: expect.any(AbortSignal),
    });
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('changes the cache identity and rejects old responses even if fetch ignores cancellation', async () => {
    const oldResponse = deferred<Response>();
    const signals: AbortSignal[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => {
      if (!init?.signal) throw new Error('Expected an abort signal.');
      signals.push(init.signal);
      return oldResponse.promise;
    }).mockResolvedValue(response());
    const loader = createCollectionTileLoader('revision-tiles', fetchTile);
    const first = loader.setSource(source());
    const pending = loader.load({ url: tileUrl(first) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const second = loader.setSource(source({ body: { filter: { op: '=', args: [{ property: 'name' }, 'new'] } } }));
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.urlTemplate).not.toBe(first.urlTemplate);
    expect(signals[0].aborted).toBe(true);
    oldResponse.resolve(response());
    await rejected;
    await expect(loader.load({ url: tileUrl(first) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loader.load({ url: tileUrl(second) }, new AbortController())).resolves.toHaveProperty('data');
    expect(fetchTile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchTile.mock.calls[1][1]?.body))).toEqual({ filter: { op: '=', args: [{ property: 'name' }, 'new'] } });
  });

  it('honors cancellation before fetch and during an active request', async () => {
    const pendingResponse = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchTile = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return pendingResponse.promise;
    });
    const loader = createCollectionTileLoader('cancel-tiles', fetchTile);
    const revision = loader.setSource(source());
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(loader.load({ url: tileUrl(revision) }, alreadyAborted)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchTile).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = loader.load({ url: tileUrl(revision) }, controller);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    pendingResponse.resolve(response());
    await rejected;
  });

  it('cleans up one loader without affecting another instance or reusing its old revision', async () => {
    const pendingResponse = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFirst = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return pendingResponse.promise;
    });
    const fetchSecond = vi.fn<typeof fetch>().mockResolvedValue(response());
    const first = createCollectionTileLoader('instance-one', fetchFirst);
    const second = createCollectionTileLoader('instance-two', fetchSecond);
    const firstRevision = first.setSource(source());
    const secondRevision = second.setSource(source());
    const pending = first.load({ url: tileUrl(firstRevision) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    first.clear();
    expect(requestSignal?.aborted).toBe(true);
    pendingResponse.resolve(response());
    await rejected;
    await expect(second.load({ url: tileUrl(secondRevision) }, new AbortController())).resolves.toHaveProperty('data');
    await expect(first.load({ url: tileUrl(firstRevision) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
    const reconnected = first.setSource(source());
    expect(reconnected.urlTemplate).not.toBe(firstRevision.urlTemplate);
    expect(fetchSecond).toHaveBeenCalledOnce();
  });

  it('does not return a body that finishes after its source was superseded', async () => {
    const bytes = deferred<ArrayBuffer>();
    const previous = response();
    vi.spyOn(previous, 'arrayBuffer').mockReturnValue(bytes.promise);
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValue(previous);
    const loader = createCollectionTileLoader('late-body', fetchTile);
    const first = loader.setSource(source());
    const pending = loader.load({ url: tileUrl(first) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(previous.arrayBuffer).toHaveBeenCalledOnce());
    loader.setSource(source({ body: {} }));
    bytes.resolve(new ArrayBuffer(1));
    await rejected;
  });

  it('treats a late obsolete network failure as cancellation', async () => {
    const oldResponse = deferred<Response>();
    const fetchTile = vi.fn<typeof fetch>().mockReturnValue(oldResponse.promise);
    const loader = createCollectionTileLoader('late-error', fetchTile);
    const previous = loader.setSource(source());
    const pending = loader.load({ url: tileUrl(previous) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    loader.setSource(source({ body: {} }));
    oldResponse.reject(new Error('An old query failed after its source was replaced.'));
    await rejected;
  });

  it('reports HTTP failure and still permits a later current request', async () => {
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Unavailable', { status: 503 })).mockResolvedValueOnce(response());
    const loader = createCollectionTileLoader('error-tiles', fetchTile);
    const revision = loader.setSource(source());
    await expect(loader.load({ url: tileUrl(revision) }, new AbortController())).rejects.toThrow('HTTP 503');
    await expect(loader.load({ url: tileUrl(revision) }, new AbortController())).resolves.toHaveProperty('data');
  });

  it('rejects invalid configurations and fails closed instead of retaining previous filters', async () => {
    const fetchTile = vi.fn<typeof fetch>();
    const loader = createCollectionTileLoader('invalid-tiles', fetchTile);
    const previous = loader.setSource(source());
    expect(() => loader.setSource(source({ urlTemplate: '/missing-tile-coordinates' }))).toThrow('{z}, {x}, and {y}');
    await expect(loader.load({ url: tileUrl(previous) }, new AbortController())).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => loader.setSource(source({ sourceLayer: '' }))).toThrow('sourceLayer');
    expect(() => loader.setSource(source({ minZoom: 8, maxZoom: 7 }))).toThrow('zoom range');
    expect(() => loader.setSource(source({ urlTemplate: 'file:///{z}/{x}/{y}' }))).toThrow('HTTP(S)');
    expect(fetchTile).not.toHaveBeenCalled();
  });

  it('rejects malformed tile coordinates without making a network request', async () => {
    const fetchTile = vi.fn<typeof fetch>();
    const loader = createCollectionTileLoader('coordinates', fetchTile);
    const revision = loader.setSource(source());
    const prefix = `coordinates://${revision.revision}`;
    await expect(loader.load({ url: `${prefix}/1/2/0` }, new AbortController())).rejects.toThrow('out of range');
    await expect(loader.load({ url: `${prefix}/1/0/not-y` }, new AbortController())).rejects.toThrow('Invalid collection tile coordinates');
    expect(fetchTile).not.toHaveBeenCalled();
  });
});

describe('collection tile status and deadlines', () => {
  it('tracks concurrent work and retains a failed tile until that exact URL succeeds', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(response());
    const loader = createCollectionTileLoader('status-tiles', fetchTile, { onStatus: status => statuses.push(status) });
    const revision = loader.setSource(source());
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 0, error: null });
    const failed = loader.load({ url: tileUrl(revision) }, new AbortController());
    const rejected = expect(failed).rejects.toThrow('HTTP 503');
    const successful = loader.load({ url: tileUrl(revision, 2054) }, new AbortController());
    expect(statuses.at(-1)?.pending).toBe(2);
    first.resolve(new Response('Unavailable', { status: 503 }));
    await rejected;
    expect(statuses.at(-1)).toMatchObject({ pending: 1, error: expect.stringContaining('HTTP 503') });
    second.resolve(response());
    await successful;
    expect(statuses.at(-1)).toMatchObject({ pending: 0, error: expect.stringContaining('HTTP 503') });
    const retry = loader.load({ url: tileUrl(revision) }, new AbortController());
    expect(statuses.at(-1)).toMatchObject({ pending: 1, error: expect.stringContaining('HTTP 503') });
    await retry;
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 0, error: null });
  });

  it('keeps other failed URLs visible when one failed URL recovers', async () => {
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());
    const loader = createCollectionTileLoader('multiple-errors', fetchTile, { onStatus: status => statuses.push(status) });
    const revision = loader.setSource(source());
    await expect(loader.load({ url: tileUrl(revision) }, new AbortController())).rejects.toThrow('HTTP 503');
    await expect(loader.load({ url: tileUrl(revision, 2054) }, new AbortController())).rejects.toThrow('HTTP 504');
    await loader.load({ url: tileUrl(revision) }, new AbortController());
    expect(statuses.at(-1)?.error).toContain('HTTP 504');
    await loader.load({ url: tileUrl(revision, 2054) }, new AbortController());
    expect(statuses.at(-1)?.error).toBeNull();
  });

  it('settles cancellation immediately even when fetch ignores abort, without adding an error or leaving timers/listeners', async () => {
    vi.useFakeTimers();
    const pendingFetch = deferred<Response>();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockReturnValue(pendingFetch.promise);
    const loader = createCollectionTileLoader('status-cancel', fetchTile, { onStatus: status => statuses.push(status), timeoutMs: 100 });
    const revision = loader.setSource(source());
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = loader.load({ url: tileUrl(revision) }, controller);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 0, error: null });
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(statuses.at(-1)?.error).toBeNull();
    pendingFetch.reject(new Error('Late canceled failure'));
    await Promise.resolve();
    expect(statuses.at(-1)?.error).toBeNull();
  });

  it('ignores superseded completions while counting only the new revision', async () => {
    const oldFetch = deferred<Response>();
    const newFetch = deferred<Response>();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockReturnValueOnce(oldFetch.promise).mockReturnValueOnce(newFetch.promise);
    const loader = createCollectionTileLoader('status-revision', fetchTile, { onStatus: status => statuses.push(status) });
    const oldRevision = loader.setSource(source());
    const obsolete = loader.load({ url: tileUrl(oldRevision) }, new AbortController());
    const rejected = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
    const revision = loader.setSource(source({ body: {} }));
    const current = loader.load({ url: tileUrl(revision) }, new AbortController());
    await rejected;
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 1, error: null });
    const count = statuses.length;
    oldFetch.reject(new Error('Obsolete network error'));
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toHaveLength(count);
    newFetch.resolve(response());
    await current;
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 0, error: null });
  });

  it('times out an uncooperative fetch after the default 60 seconds and ignores its late success', async () => {
    vi.useFakeTimers();
    const pendingFetch = deferred<Response>();
    const statuses: CollectionTileStatus[] = [];
    let requestSignal: AbortSignal | undefined;
    const fetchTile = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return pendingFetch.promise;
    });
    const loader = createCollectionTileLoader('timeout-fetch', fetchTile, { onStatus: status => statuses.push(status) });
    const revision = loader.setSource(source());
    const upstream = new AbortController();
    const removeListener = vi.spyOn(upstream.signal, 'removeEventListener');
    const pending = loader.load({ url: tileUrl(revision) }, upstream);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: 'Map tiles timed out. Retry to load locations.' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(statuses.at(-1)).toMatchObject({ pending: 1, error: null });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(statuses.at(-1)).toEqual({ revision: revision.revision, pending: 0, error: 'Map tiles timed out. Retry to load locations.' });
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const count = statuses.length;
    pendingFetch.resolve(response());
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses).toHaveLength(count);
  });

  it('uses one deadline for both fetching and a stalled response body', async () => {
    vi.useFakeTimers();
    const bytes = deferred<ArrayBuffer>();
    const tileResponse = response();
    const body = vi.spyOn(tileResponse, 'arrayBuffer').mockReturnValue(bytes.promise);
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValue(tileResponse);
    const loader = createCollectionTileLoader('timeout-body', fetchTile, { timeoutMs: 50, onStatus: status => statuses.push(status) });
    const revision = loader.setSource(source());
    const pending = loader.load({ url: tileUrl(revision) }, new AbortController());
    const rejected = expect(pending).rejects.toThrow('Map tiles timed out');
    await Promise.resolve();
    expect(body).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(statuses.at(-1)?.pending).toBe(0);
    expect(statuses.at(-1)?.error).toContain('Retry to load locations.');
    expect(vi.getTimerCount()).toBe(0);
    bytes.resolve(new ArrayBuffer(3));
    await Promise.resolve();
    expect(statuses.at(-1)?.error).toContain('timed out');
  });

  it('clear aborts active work, clears remembered failures and cancels deadlines', async () => {
    vi.useFakeTimers();
    const pendingFetch = deferred<Response>();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockReturnValueOnce(pendingFetch.promise);
    const loader = createCollectionTileLoader('status-clear', fetchTile, { timeoutMs: 20, onStatus: status => statuses.push(status) });
    const revision = loader.setSource(source());
    await expect(loader.load({ url: tileUrl(revision) }, new AbortController())).rejects.toThrow('Check your connection and retry.');
    expect(statuses.at(-1)?.error).toBe('Map tiles could not load. Check your connection and retry.');
    const pending = loader.load({ url: tileUrl(revision, 2054) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    loader.clear();
    await rejected;
    expect(statuses.at(-1)).toEqual({ revision: revision.revision + 1, pending: 0, error: null });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(statuses.at(-1)?.error).toBeNull();
    pendingFetch.resolve(response());
  });

  it('cleans timers after ordinary failures and successes and validates deadline options', async () => {
    vi.useFakeTimers();
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(response());
    const loader = createCollectionTileLoader('timeout-cleanup', fetchTile);
    const revision = loader.setSource(source());
    await expect(loader.load({ url: tileUrl(revision) }, new AbortController())).rejects.toThrow('HTTP 500');
    expect(vi.getTimerCount()).toBe(0);
    await loader.load({ url: tileUrl(revision) }, new AbortController());
    expect(vi.getTimerCount()).toBe(0);
    for (const timeoutMs of [0, -1, Number.NaN, Infinity]) {
      expect(() => createCollectionTileLoader('bad-timeout', fetchTile, { timeoutMs })).toThrow('timeoutMs');
    }
  });
});

describe('cancellable tile dispatch delay', () => {
  it('counts the wait as pending and cancels before dispatch without leaking either timer', async () => {
    vi.useFakeTimers();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValue(response());
    const loader = createCollectionTileLoader('delay-cancel', fetchTile, {
      requestDelayMs: 150, timeoutMs: 1_000, onStatus: status => statuses.push(status),
    });
    const revision = loader.setSource(source());
    const controller = new AbortController();
    const pending = loader.load({ url: tileUrl(revision) }, controller);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(statuses.at(-1)).toMatchObject({ pending: 1, error: null });
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchTile).not.toHaveBeenCalled();
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ pending: 0, error: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchTile).not.toHaveBeenCalled();
    for (const requestDelayMs of [-1, Number.NaN, Infinity, 1_000]) {
      expect(() => createCollectionTileLoader('invalid-delay', fetchTile, { requestDelayMs, timeoutMs: 1_000 })).toThrow('requestDelayMs');
    }
  });

  it('suppresses a superseded source and dispatches only the latest immutable query after its delay', async () => {
    vi.useFakeTimers();
    const statuses: CollectionTileStatus[] = [];
    const fetchTile = vi.fn<typeof fetch>().mockResolvedValue(response());
    const loader = createCollectionTileLoader('delay-latest', fetchTile, {
      requestDelayMs: 150, timeoutMs: 1_000, onStatus: status => statuses.push(status),
    });
    const first = loader.setSource(source());
    const obsolete = loader.load({ url: tileUrl(first) }, new AbortController());
    const rejected = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    const body = { filter: { op: '=', args: [{ property: 'name' }, 'latest'] } };
    const latest = loader.setSource(source({ body }));
    const current = loader.load({ url: tileUrl(latest) }, new AbortController());
    body.filter.args[1] = 'mutated';
    await rejected;
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(149);
    expect(fetchTile).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ revision: latest.revision, pending: 1, error: null });
    await vi.advanceTimersByTimeAsync(1);
    await expect(current).resolves.toHaveProperty('data');
    expect(fetchTile).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchTile.mock.calls[0][1]?.body))).toEqual({ filter: { op: '=', args: [{ property: 'name' }, 'latest'] } });
    expect(statuses.at(-1)).toEqual({ revision: latest.revision, pending: 0, error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes the dispatch delay in the overall request deadline', async () => {
    vi.useFakeTimers();
    const blocked = deferred<Response>();
    const fetchTile = vi.fn<typeof fetch>().mockReturnValue(blocked.promise);
    const loader = createCollectionTileLoader('delay-deadline', fetchTile, { requestDelayMs: 150, timeoutMs: 200 });
    const revision = loader.setSource(source());
    const pending = loader.load({ url: tileUrl(revision) }, new AbortController());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchTile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    blocked.resolve(response());
  });
});
