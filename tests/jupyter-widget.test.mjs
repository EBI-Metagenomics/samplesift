import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/samplesift/jupyter/static/widget.js', import.meta.url), 'utf8');
const { default: widget } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const emptyState = () => ({ predicates: [], sort: [], selection: null });

function modelFor(state) {
  const listeners = new Map();
  return {
    listeners, saves: 0,
    get: name => state[name],
    set(values) {
      for (const [key, value] of Object.entries(values)) {
        const changed = JSON.stringify(state[key]) !== JSON.stringify(value);
        state[key] = value;
        if (changed) listeners.get(`change:${key}`)?.();
      }
    },
    save_changes() { this.saves++; },
    on: (name, fn) => listeners.set(name, fn),
    off: name => listeners.delete(name),
  };
}

function setup() {
  class Component extends EventTarget {
    calls = [];
    setCollectionState(state) {
      if (state.predicates.some(predicate => predicate.field === 'invalid')) throw new Error('Unknown field');
      this.collectionState = state;
      this.calls.push(state);
    }
    remove() { this.removed = true; }
  }
  const component = new Component();
  const state = {
    component_url: 'data:text/javascript,export{}', demo: false,
    api_url: 'http://localhost/samplesift', collection: 'occurrences', tile_layer: 'occurrences',
    query_state: emptyState(), page: {}, query_error: '',
  };
  const model = modelFor(state);
  return { component, state, model };
}

async function render(component, model) {
  const original = globalThis.document;
  globalThis.document = { createElement: () => component };
  try {
    return await widget.render({ model, el: { append: node => assert.equal(node, component) } });
  } finally { globalThis.document = original; }
}
const emit = (component, name, detail) => component.dispatchEvent(new CustomEvent(name, { detail }));

test('initial Python state waits for metadata; browser reflection does not repeat searches', async () => {
  const { component, state, model } = setup();
  const cleanup = await render(component, model);
  assert.equal(component.collectionPaused, true);
  const initial = { ...emptyState(), predicates: [{ field: 'depth', operator: '>=', value: 50 }] };
  model.set({ query_state: initial });
  assert.equal(component.calls.length, 0);
  emit(component, 'collectionready', {});
  assert.deepEqual(component.calls, [initial]);
  assert.equal(component.collectionPaused, false);
  const drawn = { ...initial, selection: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  component.collectionState = drawn;
  emit(component, 'collectionstatechange', { state: drawn });
  assert.deepEqual(state.query_state, drawn);
  assert.equal(component.calls.length, 1);
  const page = { state: drawn, query: { limit: 1, offset: 0 }, result: { items: [{ source_pk: 'a', depth: 12 }], total: 99, limit: 1, offset: 0 } };
  emit(component, 'collectionresultschange', page);
  assert.equal(component.calls.length, 1);
  assert.equal(state.page.api_url, component.apiUrl);
  page.result.items[0].depth = 0;
  assert.equal(state.page.result.items[0].depth, 12);
  const status = { loading: false, pending: 0, error: null, revision: 2, ready: true, query: {} };
  emit(component, 'collectiontileschange', status);
  assert.deepEqual(state.tile_status, status);
  const updated = { ...drawn, sort: ['date'] };
  model.set({ query_state: updated });
  assert.equal(component.calls.length, 2);
  emit(component, 'collectionresultschange', page);
  assert.equal(state.page.state.sort.length, 0); // Stale results did not replace the page.
  cleanup();
  assert.equal(model.listeners.size, 0);
  assert.equal(component.removed, true);
  const before = model.saves;
  emit(component, 'collectionresultschange', { ...page, state: updated });
  assert.equal(model.saves, before);
});

test('invalid Python filters pause the search and expose an error; valid filters recover', async () => {
  const { component, state, model } = setup();
  const cleanup = await render(component, model);
  emit(component, 'collectionready', {});
  model.set({ query_state: { ...emptyState(), predicates: [{ field: 'invalid', operator: '=', value: 1 }] } });
  assert.equal(state.query_error, 'Unknown field');
  assert.equal(component.collectionPaused, true);
  assert.deepEqual(state.page, {});
  model.set({ query_state: emptyState() });
  assert.equal(state.query_error, '');
  assert.equal(component.collectionPaused, false);
  cleanup();
});
