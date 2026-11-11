import { isValidCoordinate } from '../data/validation';
import { validateCollectionQuery } from './cql2';
import { isRecord, parseCollectionMetadata } from './schema';
import type { CollectionDataSource, CollectionItem, CollectionMetadata, CollectionOptions, CollectionQuery, CollectionResult } from './types';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
function appendPath(baseUrl: string, suffix: string): string {
  const input = baseUrl.trim().split('#', 1)[0];
  const queryIndex = input.indexOf('?');
  const path = queryIndex < 0 ? input : input.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : input.slice(queryIndex + 1);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//')) {
    let url: URL;
    try { url = new URL(path.startsWith('//') ? `https:${path}` : path); } catch { throw new Error('Collection baseUrl must be a valid HTTP(S) or relative API root.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Collection baseUrl must use HTTP or HTTPS.');
  }
  return `${path.replace(/\/+$/, '')}/${suffix}${query ? `?${query}` : ''}`;
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  if (!response.ok) {
    let detail = response.statusText || 'Request failed';
    try {
      const text = await response.text();
      try {
        const body: unknown = JSON.parse(text);
        if (isRecord(body)) {
          const message = body.detail ?? body.message ?? body.error;
          if (typeof message === 'string' && message.trim()) detail = message;
        }
      } catch {
        if (text && !text.trimStart().startsWith('<')) detail = text;
      }
    } catch { /* Status is still useful if the response body is unavailable. */ }
    throwIfAborted(signal);
    throw new Error(`Collection request failed (HTTP ${response.status}): ${detail.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  try {
    const result: unknown = await response.json();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`Invalid collection response: expected JSON. ${error instanceof SyntaxError ? '' : error instanceof Error ? error.message : ''}`.trim());
  }
}
function validateItem(value: unknown): asserts value is CollectionItem {
  if (!isRecord(value) || typeof value.source_pk !== 'string' || !value.source_pk) throw new Error('Collection items require a nonempty source_pk string.');
  if (value.geometry === null) return;
  if (!isRecord(value.geometry) || value.geometry.type !== 'Point' || !Array.isArray(value.geometry.coordinates)
    || value.geometry.coordinates.length < 2 || value.geometry.coordinates.length > 3
    || !isValidCoordinate(value.geometry.coordinates[0], value.geometry.coordinates[1])
    || (value.geometry.coordinates.length === 3 && (typeof value.geometry.coordinates[2] !== 'number' || !Number.isFinite(value.geometry.coordinates[2])))) {
    throw new Error('Collection item geometry must be a valid GeoJSON Point in EPSG:4326 or null.');
  }
}
function parseResult(value: unknown, query: CollectionQuery, metadata: CollectionMetadata): CollectionResult {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('Collection response must contain an items array.');
  const items = value.items;
  const identities = new Set<string>();
  for (const item of items) {
    validateItem(item);
    if (identities.has(item.source_pk)) throw new Error('Collection response contains duplicate source_pk values.');
    identities.add(item.source_pk);
  }
  if (value.total !== undefined && (!Number.isSafeInteger(value.total) || (value.total as number) < items.length)) throw new Error('Collection total must be a nonnegative integer at least as large as this page.');
  const limit = value.limit === undefined ? query.limit ?? metadata.defaultLimit : value.limit;
  const offset = value.offset === undefined ? query.offset ?? 0 : value.offset;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > metadata.maxLimit || items.length > (limit as number)) throw new Error('Collection response has an invalid limit or too many items.');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Collection response offset must be a nonnegative integer.');
  if (typeof value.total === 'number' && items.length > 0 && (offset as number) > value.total - items.length) throw new Error('Collection total is inconsistent with the page offset and items.');
  const nextCursor = value.nextCursor ?? value.next_cursor;
  if (nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor)) throw new Error('Collection next cursor must be a nonempty string or null.');
  return {
    ...structuredClone(value),
    items: structuredClone(items),
    limit: limit as number,
    offset: offset as number,
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  } as CollectionResult;
}

/** Backend API root includes /samplesift. Requests use the read-only HTTP QUERY method. */
export function createCollectionDataSource(options: CollectionOptions): CollectionDataSource {
  if (!isRecord(options) || typeof options.baseUrl !== 'string' || typeof options.collection !== 'string' || !options.collection.trim()) throw new Error('Collection options require an API baseUrl and collection identifier.');
  const configuration = structuredClone(options);
  const root = `collections/${encodeURIComponent(configuration.collection)}`;
  const queryablesUrl = appendPath(configuration.baseUrl, `${root}/queryables`);
  const openapiUrl = appendPath(configuration.baseUrl, 'openapi.json');
  const resultsUrl = appendPath(configuration.baseUrl, `${root}/results`);
  const tileUrlTemplate = appendPath(configuration.baseUrl, `${root}/tiles/{z}/{x}/{y}`);
  let cached: CollectionMetadata | undefined;

  async function metadata({ signal }: { signal: AbortSignal }): Promise<CollectionMetadata> {
    throwIfAborted(signal);
    if (cached) return structuredClone(cached);
    const [queryables, openapi] = await Promise.all([
      fetch(queryablesUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal }).then(response => readJson(response, signal)),
      fetch(openapiUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal }).then(response => readJson(response, signal)),
    ]);
    throwIfAborted(signal);
    const parsed = parseCollectionMetadata(queryables, openapi, configuration);
    cached = structuredClone(parsed);
    return structuredClone(parsed);
  }
  return {
    metadata,
    tileUrlTemplate,
    async search(query, { signal }) {
      throwIfAborted(signal);
      const request = structuredClone(query);
      const model = await metadata({ signal });
      throwIfAborted(signal);
      validateCollectionQuery(request, model);
      const response = await fetch(resultsUrl, {
        method: 'QUERY',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      const raw = await readJson(response, signal);
      throwIfAborted(signal);
      return parseResult(raw, request, model);
    },
  };
}
