import type { SampleDataSource } from '../types';
import { validateSearchQuery, validateSearchResult } from './validation';

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

/** HTTP contract: POST <baseUrl>/samples/search with a JSON SearchQuery. */
export function createHttpDataSource({ baseUrl }: { baseUrl: string }): SampleDataSource {
  if (typeof baseUrl !== 'string') throw new Error('API baseUrl must be a string.');
  const endpoint = `${baseUrl.trim().replace(/\/+$/, '')}/samples/search`;
  return {
    async search(query, { signal }) {
      if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      validateSearchQuery(query);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(query),
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
      try { validateSearchResult(result, query); } catch (error) {
        throw new Error(`Invalid search response: ${error instanceof Error ? error.message : String(error)}`);
      }
      return result;
    },
  };
}
