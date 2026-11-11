// This is application-owned routing code, never part of the reusable component.
import '../src/index';
import { applyCollectionQueryPatch, createCollectionQueryPatch, readCollectionQuery } from '../src/collection/index';
import type { SampleSift } from '../src/components/sample-sift';
import type { CollectionSearchState } from '../src/collection/types';

const instances = [...document.querySelectorAll<SampleSift>('sample-sift')];
const errors = new Map<string, string>();
const errorDisplay = document.querySelector<HTMLElement>('#route-error');
function restore(explorer: SampleSift) {
  const metadata = explorer.collectionMetadata;
  if (!metadata) return;
  explorer.collectionPaused = true;
  try {
    const state = readCollectionQuery(new URL(location.href).searchParams, metadata, { namespace: explorer.id });
    if (JSON.stringify(explorer.collectionState) !== JSON.stringify(state)) explorer.setCollectionState(state);
    explorer.collectionPaused = false;
    errors.delete(explorer.id);
  } catch (error) {
    errors.set(explorer.id, `${explorer.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (errorDisplay) errorDisplay.textContent = [...errors.values()].join(' ');
}
for (const explorer of instances) {
  explorer.mapStyle = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eee3' } }] };
  explorer.addEventListener('collectionready', () => restore(explorer));
  explorer.addEventListener('collectionstatechange', event => {
    const state = (event as CustomEvent<{ state: CollectionSearchState }>).detail.state;
    const latest = new URL(location.href);
    latest.search = applyCollectionQueryPatch(latest.searchParams, createCollectionQueryPatch(state, { namespace: explorer.id })).toString();
    if (latest.href !== location.href) history.pushState(history.state, '', latest);
  });
}
window.addEventListener('popstate', () => instances.forEach(restore));
