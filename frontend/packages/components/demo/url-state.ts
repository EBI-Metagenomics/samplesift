// Host application code: routing is deliberately outside the component package.
import '../src/index';
import { applyFilterQueryPatch, createFilterQueryPatch, readFilterQuery } from '../src/data';
import type { FiltersChangeDetail, SampleFilters } from '../src/types';
import type { SampleSift } from '../src/components/sample-sift';
import { taxonomyOptions } from './taxonomy-options';

const instances = [...document.querySelectorAll<SampleSift>('sample-sift')];
const error = document.querySelector<HTMLElement>('#route-error');
const tab = document.querySelector<HTMLSelectElement>('#host-tab');
const currentTab = document.querySelector<HTMLElement>('#current-tab');
if (!error || !tab || !currentTab) throw new Error('Missing host example elements.');

function restoreFromUrl() {
  if (!error || !tab || !currentTab) return;
  const params = new URL(location.href).searchParams;
  try {
    // Parse every instance before applying any state. Invalid constraints never broaden a search.
    const restored = instances.map(element => ({
      element, filters: readFilterQuery(params, { namespace: element.id }),
    }));
    error.textContent = '';
    for (const { element, filters } of restored) {
      if (JSON.stringify(element.filters) !== JSON.stringify(filters)) element.setSearchState({ filters });
      element.demo = true;
    }
  } catch (reason) {
    error.textContent = `Cannot restore these filters: ${reason instanceof Error ? reason.message : String(reason)}`;
    for (const element of instances) element.demo = false;
  }
  const value = params.get('tab') ?? 'results';
  currentTab.textContent = value;
  tab.value = value;
}

function commitFilters(namespace: string, filters: SampleFilters) {
  const next = new URL(location.href); // Always merge into the latest host state.
  next.search = applyFilterQueryPatch(next.searchParams, createFilterQueryPatch(filters, { namespace })).toString();
  if (next.href !== location.href) history.pushState(history.state, '', next);
  restoreFromUrl();
}

for (const element of instances) {
  element.filterFields = ['n50', 'taxonomy'];
  element.taxonomyOptions = taxonomyOptions;
  element.mapStyle = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eee3' } }] };
  element.addEventListener('filterschange', event => {
    commitFilters(element.id, (event as CustomEvent<FiltersChangeDetail>).detail.filters);
  });
}

tab.addEventListener('change', () => {
  const next = new URL(location.href);
  next.searchParams.set('tab', tab.value);
  history.pushState(history.state, '', next);
  restoreFromUrl();
});
window.addEventListener('popstate', restoreFromUrl);
restoreFromUrl();
