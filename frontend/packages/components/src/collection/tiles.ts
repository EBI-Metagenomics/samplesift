import type { Geometry } from 'geojson';

export interface CollectionTileSource {
  urlTemplate: string;
  sourceLayer: string;
  body: Record<string, unknown>;
  minZoom?: number;
  maxZoom?: number;
}

export interface CollectionFeatureClickDetail {
  id: string;
  properties: Record<string, unknown>;
  geometry: Geometry;
}

export interface TileSourceRevision {
  revision: number;
  urlTemplate: string;
  sourceLayer: string;
  minZoom: number;
  maxZoom: number;
}

interface TileRequestSnapshot extends TileSourceRevision {
  endpointTemplate: string;
  jsonBody: string;
}

export interface CollectionTileStatus {
  pending: number;
  error: string | null;
  revision: number;
}

export interface CollectionTileLoaderOptions {
  onStatus?: (status: CollectionTileStatus) => void;
  /** Deadline for both the response headers and body; defaults to 60 seconds. */
  timeoutMs?: number;
  /** Cancellable wait before HTTP dispatch; defaults to zero. Counts toward timeoutMs. */
  requestDelayMs?: number;
}

class TileLoadError extends Error {}

const TIMEOUT_MESSAGE = 'Map tiles timed out. Retry to load locations.';
const NETWORK_MESSAGE = 'Map tiles could not load. Check your connection and retry.';

type TileRequest = { url: string };
type TileResponse = { data: ArrayBuffer };

function aborted(): DOMException {
  return new DOMException('The tile request was superseded or aborted.', 'AbortError');
}

function validateSource(source: CollectionTileSource): void {
  if (typeof source.urlTemplate !== 'string' || !source.urlTemplate.trim()
    || !['{z}', '{x}', '{y}'].every((token) => source.urlTemplate.includes(token))) {
    throw new Error('Collection tile URL must include {z}, {x}, and {y}.');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source.urlTemplate) && !/^https?:\/\//i.test(source.urlTemplate)) {
    throw new Error('Collection tile URL must use HTTP(S) or a relative URL.');
  }
  if (typeof source.sourceLayer !== 'string' || !source.sourceLayer.trim()) {
    throw new Error('Collection tile sourceLayer must be a nonempty string.');
  }
  if (!source.body || typeof source.body !== 'object' || Array.isArray(source.body)) {
    throw new Error('Collection tile request body must be an object.');
  }
  const min = source.minZoom ?? 0;
  const max = source.maxZoom ?? 22;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 24 || min > max) {
    throw new Error('Collection tile zoom range must use integers from 0 through 24.');
  }
}

/**
 * One map's protocol handler. It has no MapLibre or DOM dependency.
 * The map owns addProtocol/removeProtocol; clear() cancels only this loader's work.
 */
export function createCollectionTileLoader(
  protocol: string,
  fetchTile: typeof fetch = globalThis.fetch,
  options: CollectionTileLoaderOptions = {},
) {
  if (!/^[a-z][a-z0-9+.-]*$/.test(protocol)) throw new Error('Invalid collection tile protocol name.');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Tile timeoutMs must be a positive finite duration.');
  const requestDelayMs = options.requestDelayMs ?? 0;
  if (!Number.isFinite(requestDelayMs) || requestDelayMs < 0 || requestDelayMs >= timeoutMs) throw new Error('Tile requestDelayMs must be nonnegative and shorter than timeoutMs.');
  if (options.onStatus !== undefined && typeof options.onStatus !== 'function') throw new Error('Tile onStatus must be a function.');
  const onStatus = options.onStatus;
  let revision = 0;
  let snapshot: TileRequestSnapshot | undefined;
  const active = new Set<AbortController>();
  const failures = new Map<string, string>();
  const emitStatus = () => {
    // Status observers must not interrupt request cleanup or transport behavior.
    try { onStatus?.({ pending: active.size, error: failures.values().next().value ?? null, revision }); } catch { /* Observer errors do not fail tiles. */ }
  };

  const clear = () => {
    revision += 1;
    snapshot = undefined;
    for (const controller of active) controller.abort(aborted());
    active.clear();
    failures.clear();
    emitStatus();
  };

  const setSource = (source: CollectionTileSource): TileSourceRevision => {
    // Invalidate previous requests even if the new configuration is invalid.
    clear();
    validateSource(source);
    const jsonBody = JSON.stringify(structuredClone(source.body));
    const next: TileRequestSnapshot = {
      revision,
      urlTemplate: `${protocol}://${revision}/{z}/{x}/{y}`,
      endpointTemplate: source.urlTemplate,
      sourceLayer: source.sourceLayer,
      minZoom: source.minZoom ?? 0,
      maxZoom: source.maxZoom ?? 22,
      jsonBody,
    };
    snapshot = next;
    return {
      revision: next.revision,
      urlTemplate: next.urlTemplate,
      sourceLayer: next.sourceLayer,
      minZoom: next.minZoom,
      maxZoom: next.maxZoom,
    };
  };

  const load = async (request: TileRequest, upstream: AbortController): Promise<TileResponse> => {
    const captured = snapshot;
    if (!captured || upstream.signal.aborted) throw aborted();
    const prefix = `${protocol}://${captured.revision}/`;
    if (!request.url.startsWith(prefix)) throw aborted();
    const coordinates = request.url.slice(prefix.length).split('/');
    if (coordinates.length !== 3 || coordinates.some((coordinate) => !/^\d+$/.test(coordinate))) {
      throw new Error('Invalid collection tile coordinates.');
    }
    const [z, x, y] = coordinates.map(Number);
    if (z < 0 || z > 24 || x >= 2 ** z || y >= 2 ** z) throw new Error('Collection tile coordinates are out of range.');
    const endpoint = captured.endpointTemplate.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
    const controller = new AbortController();
    let timeoutError: TileLoadError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let onInterrupted = () => {};
    const current = () => snapshot === captured && revision === captured.revision;
    const assertCurrent = () => {
      if (!current() || upstream.signal.aborted) throw aborted();
      if (timeoutError) throw timeoutError;
      if (controller.signal.aborted) throw aborted();
    };
    // Race a separate rejection so even a fetch/body implementation that ignores abort settles.
    const interrupted = new Promise<never>((_resolve, reject) => {
      onInterrupted = () => reject(controller.signal.reason ?? aborted());
      controller.signal.addEventListener('abort', onInterrupted, { once: true });
      timer = setTimeout(() => {
        timeoutError = new TileLoadError(TIMEOUT_MESSAGE);
        timeoutError.name = 'TimeoutError';
        controller.abort(timeoutError);
      }, timeoutMs);
    });
    const cancel = () => controller.abort(aborted());
    upstream.signal.addEventListener('abort', cancel, { once: true });
    active.add(controller);
    emitStatus();
    try {
      const operation = (async (): Promise<TileResponse> => {
        assertCurrent();
        if (requestDelayMs > 0) {
          const delay = new Promise<void>(resolve => { delayTimer = setTimeout(resolve, requestDelayMs); });
          await Promise.race([delay, interrupted]);
          assertCurrent();
        }
        const response = await fetchTile(endpoint, {
          method: 'QUERY',
          headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.mapbox-vector-tile' },
          body: captured.jsonBody,
          signal: controller.signal,
        });
        assertCurrent();
        if (!response.ok) throw new TileLoadError(`Map tiles could not load (HTTP ${response.status}). Retry to load locations.`);
        const data = await response.arrayBuffer();
        assertCurrent();
        return { data };
      })();
      const result = await Promise.race([operation, interrupted]);
      assertCurrent();
      failures.delete(request.url);
      return result;
    } catch (error) {
      // Cancellation and supersession take precedence over a simultaneous timeout/failure.
      if (!current() || upstream.signal.aborted || (controller.signal.aborted && !timeoutError)) throw aborted();
      const failure = timeoutError ?? (error instanceof TileLoadError ? error : new TileLoadError(NETWORK_MESSAGE, { cause: error }));
      failures.set(request.url, failure.message);
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      controller.signal.removeEventListener('abort', onInterrupted);
      upstream.signal.removeEventListener('abort', cancel);
      active.delete(controller);
      if (current()) emitStatus();
    }
  };

  return { setSource, load, clear };
}
