import type { CollectionMetadata, CollectionSearchState, SpatialMapping } from './types';
import { createEmptyCollectionState } from './types';
import { isRecord } from './schema';
import { validateCollectionState, validateCollectionStateShape } from './cql2';

function stateKey(namespace: string): string {
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error('Collection namespace must contain 1–64 letters, digits, underscores or hyphens.');
  return `sf.${namespace}.query`;
}

/** Pure patch: apply to the host's latest query state. No routing or browser globals are used. */
export function createCollectionQueryPatch(
  state: CollectionSearchState,
  { namespace }: { namespace: string },
): ReadonlyMap<string, string | null> {
  const key = stateKey(namespace);
  validateCollectionStateShape(state);
  const empty = !state.predicates.length && !state.sort.length && state.selection === null;
  const value = empty ? null : JSON.stringify({ v: 1, predicates: state.predicates, sort: state.sort, selection: state.selection });
  return new Map([[key, value]]);
}

export function readCollectionQuery(
  params: URLSearchParams,
  metadata: CollectionMetadata,
  { namespace, spatial }: { namespace: string; spatial?: SpatialMapping },
): CollectionSearchState {
  const values = params.getAll(stateKey(namespace));
  if (values.length > 1) throw new Error('Collection URL state must appear only once per namespace.');
  if (values.length === 0) return createEmptyCollectionState();
  let payload: unknown;
  try { payload = JSON.parse(values[0]); } catch { throw new Error('Collection URL state is not valid JSON.'); }
  if (!isRecord(payload) || payload.v !== 1) throw new Error('Unsupported collection URL-state version.');
  for (const key of Object.keys(payload)) {
    if (!['v', 'predicates', 'sort', 'selection'].includes(key)) throw new Error(`Unsupported collection URL-state field: ${key}.`);
  }
  const state = { predicates: payload.predicates, sort: payload.sort, selection: payload.selection };
  validateCollectionState(state, metadata, spatial);
  return structuredClone(state);
}

export function applyCollectionQueryPatch(
  current: URLSearchParams,
  patch: ReadonlyMap<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of patch) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}
