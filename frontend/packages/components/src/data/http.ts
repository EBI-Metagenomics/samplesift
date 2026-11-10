import type { SampleDataSource } from '../types';
import { validateSearchQuery, validateSearchResult } from './validation';
import { applyApiFilters, validateFilterParameterNames, type FilterParameterNames } from './query-params';

export interface HttpDataSourceOptions {
  baseUrl: string;
  filterTransport?: 'json' | 'query';
  parameterNames?: FilterParameterNames;
}

async function httpError(response: Response): Promise<Error> {
  let detail = response.statusText || 'Request failed';
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          const fields = parsed as Record<string, unknown>;
          const message = fields.detail ?? fields.message ?? fields.error;
          if (typeof message === 'string' && message.trim()) detail = message;
        }
      } catch {
        // Avoid showing an HTML error document in the widget.
        if (!body.trimStart().startsWith('<')) detail = body;
      }
    }
  } catch { /* Status remains useful if the error body cannot be read. */ }
  return new Error(`Sample search failed (HTTP ${response.status}): ${detail.replace(/\s+/g, ' ').slice(0, 240)}`);
}

function searchEndpoint(baseUrl: string): { path: string; params: URLSearchParams } {
  const input = baseUrl.trim();
  const withoutFragment = input.split('#', 1)[0];
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(withoutFragment) || withoutFragment.startsWith('//')) {
    const protocolRelative = withoutFragment.startsWith('//');
    let url: URL;
    try { url = new URL(protocolRelative ? `https:${withoutFragment}` : withoutFragment); } catch {
      throw new Error('API baseUrl must be a valid HTTP(S) or relative URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('API baseUrl must use HTTP or HTTPS.');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/samples/search`;
    const params = new URLSearchParams(url.search);
    url.search = '';
    url.hash = '';
    return { path: protocolRelative ? url.toString().replace(/^https:/, '') : url.toString(), params };
  }
  const queryIndex = withoutFragment.indexOf('?');
  const path = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : withoutFragment.slice(queryIndex + 1);
  return { path: `${path.replace(/\/+$/, '')}/samples/search`, params: new URLSearchParams(query) };
}

/**
 * POST <baseUrl>/samples/search. JSON filters are the compatibility default.
 * Query transport sends filters in URL parameters and only selection/offset/limit in JSON.
 */
export function createHttpDataSource({
  baseUrl,
  filterTransport = 'json',
  parameterNames,
}: HttpDataSourceOptions): SampleDataSource {
  if (typeof baseUrl !== 'string') throw new Error('API baseUrl must be a string.');
  if (filterTransport !== 'json' && filterTransport !== 'query') {
    throw new Error('Filter transport must be json or query.');
  }
  validateFilterParameterNames(parameterNames);
  const mapping = parameterNames ? { ...parameterNames } : undefined;
  const endpoint = searchEndpoint(baseUrl);
  return {
    async search(query, { signal }) {
      if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      validateSearchQuery(query);
      const request = structuredClone(query);
      const params = filterTransport === 'query'
        ? applyApiFilters(endpoint.params, request.filters, mapping)
        : endpoint.params;
      const queryString = params.toString();
      const url = `${endpoint.path}${queryString ? `?${queryString}` : ''}`;
      const body = filterTransport === 'query'
        ? { selection: request.selection, offset: request.offset, limit: request.limit }
        : request;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const error = await httpError(response);
        if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        throw error;
      }
      let result: unknown;
      try { result = await response.json(); } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        throw new Error('Invalid search response: expected JSON.');
      }
      if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      try { validateSearchResult(result, request); } catch (error) {
        throw new Error(`Invalid search response: ${error instanceof Error ? error.message : String(error)}`);
      }
      return result;
    },
  };
}
