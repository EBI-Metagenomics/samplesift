import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import type { Polygon } from 'geojson';
import type { StyleSpecification } from 'maplibre-gl';
import { createDemoSamples, createFixtureDataSource, createHttpDataSource } from '../data/index';
import { EMPTY_FILTERS } from '../types';
import { validateFilters } from '../data/filters';
import { validatePolygon, validateSearchQuery } from '../data/validation';
import type { Sample, SampleDataSource, SampleFilters, SearchQuery, SearchResult, SelectionChangeDetail, SampleClickDetail, FilterField, TaxonomyOption } from '../types';
import './selection-map';
import type { SampleSiftMap } from './selection-map';
import './collection-explorer';
import type { SampleSiftCollection } from './collection-explorer';
import type { CollectionMetadata, CollectionOptions, CollectionSearchState } from '../collection/types';
import { createEmptyCollectionState } from '../collection/types';

/** Complete browser-native explorer. All public data and events use ordinary objects. */
export class SampleSift extends LitElement {
  static properties = {
    apiUrl: { type: String, attribute: 'api-url' },
    collection: { type: String },
    tileLayer: { type: String, attribute: 'tile-layer' },
    collectionOptions: { attribute: false },
    collectionState: { attribute: false },
    collectionPaused: { type: Boolean, attribute: 'collection-paused' },
    filterMode: { type: String, attribute: 'filter-mode' },
    filterDebounceMs: { type: Number, attribute: 'filter-debounce-ms' },
    demo: { type: Boolean },
    pageSize: { type: Number, attribute: 'page-size' },
    dataSource: { attribute: false },
    filters: { attribute: false },
    filterFields: { attribute: false },
    taxonomyOptions: { attribute: false },
    _filterDrafts: { state: true },
    _filterError: { state: true },
    selection: { attribute: false },
    mapStyle: { attribute: false },
    _result: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _offset: { state: true },
    _biomes: { state: true },
    _activeSample: { state: true },
  };

  apiUrl = '';
  collection = '';
  tileLayer = '';
  collectionOptions?: CollectionOptions;
  collectionState: CollectionSearchState = createEmptyCollectionState();
  collectionPaused = false;
  filterMode: 'auto' | 'manual' = 'manual';
  filterDebounceMs = 500;
  private _collectionConfig?: CollectionOptions;
  demo = false;
  pageSize = 10;
  dataSource: SampleDataSource | undefined;
  filters: SampleFilters = { ...EMPTY_FILTERS };
  filterFields: readonly FilterField[] = ['n50', 'taxonomy', 'biome', 'collectionDate'];
  taxonomyOptions: readonly TaxonomyOption[] = [];
  private _filterDrafts: Partial<SampleFilters> = {};
  private _filterError = '';
  selection: Polygon | null = null;
  mapStyle: StyleSpecification | string | undefined;
  private _result: SearchResult | null = null;
  private _loading = false;
  private _error = '';
  private _offset = 0;
  private _biomes: string[] = [];
  private _activeSample = '';
  private _source: SampleDataSource | undefined;
  private _sourceError = '';
  private _request: AbortController | undefined;
  private _requestId = 0;

  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) void this.refresh();
  }

  disconnectedCallback() {
    this._request?.abort();
    this._requestId++;
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues<this>) {
    const collectionChanged = changed.has('collectionOptions') || changed.has('collection') || changed.has('tileLayer') || changed.has('apiUrl');
    if (collectionChanged) {
      this._collectionConfig = this.collectionOptions ?? (this.collection ? {
        baseUrl: this.apiUrl || '/samplesift', collection: this.collection,
        ...(this.tileLayer ? { tiles: { sourceLayer: this.tileLayer } } : {}),
      } : undefined);
    }
    if (this._collectionConfig) {
      this._request?.abort(); this._requestId++; this._source = undefined; this._result = null;
      return;
    }
    const sourceChanged = collectionChanged || changed.has('dataSource') || changed.has('demo');
    if (sourceChanged) {
      this._sourceError = '';
      try {
        this._source = this.dataSource
          ?? (this.apiUrl.trim() ? createHttpDataSource({ baseUrl: this.apiUrl.trim(), filterTransport: 'query' }) : undefined)
          ?? (this.demo ? createFixtureDataSource(createDemoSamples(), { latencyMs: 160 }) : undefined);
      } catch (error) {
        this._source = undefined;
        this._sourceError = error instanceof Error ? error.message : 'The data source could not be configured.';
      }
      this._biomes = [];
    }
    if (changed.has('filters')) this.resetFilterDrafts(this.filters);
    if (sourceChanged || changed.has('selection') || changed.has('filters') || changed.has('pageSize')) {
      this._offset = 0;
      void this.refresh();
    }
  }

  /** Programmatic updates are validated and never emit filterschange. */
  setFilters(filters: Partial<SampleFilters>) {
    const next = { ...this.filters, ...filters };
    validateFilters(next);
    this.resetFilterDrafts(next);
    this.filters = next;
  }

  /** Apply a host-restored search atomically; one Lit update produces one request. */
  setSearchState(state: { filters?: Partial<SampleFilters>; selection?: Polygon | null }) {
    const filters = { ...this.filters, ...state.filters };
    validateFilters(filters);
    const selection = state.selection === undefined ? this.selection : state.selection;
    if (selection !== null) validatePolygon(selection);
    const geometry = selection ? structuredClone(selection) : null;
    this.resetFilterDrafts(filters);
    this.filters = filters;
    this.selection = geometry;
    this._offset = 0;
  }

  private resetFilterDrafts(filters: SampleFilters) {
    this._filterDrafts = {};
    this._filterError = '';
    // Explicitly reset number inputs: browsers retain malformed text while .value is empty.
    for (const [id, key] of [['n50-min', 'n50MinBp'], ['n50-max', 'n50MaxBp']] as const) {
      const input = this.renderRoot.querySelector<HTMLInputElement>(`#${id}`);
      if (input) input.value = filters?.[key] == null ? '' : String(filters[key]);
    }
  }

  private blockInvalidFilters(error: unknown) {
    this._filterError = error instanceof Error ? error.message : 'Check the filter values.';
    this._request?.abort();
    this._requestId++;
    this._loading = false;
    this._result = null;
    this._error = '';
  }

  private previewFilterInput(key: 'n50MinBp' | 'n50MaxBp' | 'taxonId' | 'dateFrom' | 'dateTo', event: Event) {
    const input = event.target as HTMLInputElement;
    const numeric = key === 'n50MinBp' || key === 'n50MaxBp';
    const value = numeric
      ? input.validity.badInput ? Number.NaN : input.value === '' ? null : input.valueAsNumber
      : input.validity.badInput ? 'Invalid date' : input.value.trim() || null;
    this._filterDrafts = { ...this._filterDrafts, [key]: value };
    try {
      validateFilters({ ...this.filters, ...this._filterDrafts });
      this._filterError = '';
    } catch (error) {
      this.blockInvalidFilters(error);
    }
  }

  private commitUserFilters(patch: Partial<SampleFilters> = {}, replace = false) {
    const next = replace ? { ...EMPTY_FILTERS, ...patch } : { ...this.filters, ...this._filterDrafts, ...patch };
    try {
      validateFilters(next);
      this._filterDrafts = {};
      this._filterError = '';
      this.filters = next;
      // The event is independent of network success and precedes the scheduled search.
      this.dispatchEvent(new CustomEvent('filterschange', {
        detail: { filters: { ...next } }, bubbles: true, composed: true,
      }));
    } catch (error) {
      this._filterDrafts = { ...this._filterDrafts, ...patch };
      this.blockInvalidFilters(error);
    }
  }

  private clearUserFilters() {
    this.resetFilterDrafts(EMPTY_FILTERS);
    this.commitUserFilters(EMPTY_FILTERS, true);
  }
  setSelection(selection: Polygon | null) { this.selection = selection ? structuredClone(selection) : null; }
  clearSelection() { this.selection = null; }

  get collectionMetadata(): CollectionMetadata | undefined {
    return this.renderRoot.querySelector<SampleSiftCollection>('sample-sift-collection')?.metadata;
  }
  setCollectionState(state: CollectionSearchState) {
    const explorer = this.renderRoot.querySelector<SampleSiftCollection>('sample-sift-collection');
    if (explorer) { explorer.setState(state); this.collectionState = explorer.state; }
    else this.collectionState = structuredClone(state);
  }
  private onCollectionState(event: CustomEvent) {
    // Keep the same immutable state reference to avoid a second search during event reflection.
    this.collectionState = (event.currentTarget as SampleSiftCollection).state;
  }

  async refresh(): Promise<void> {
    if (this._collectionConfig) {
      await this.renderRoot.querySelector<SampleSiftCollection>('sample-sift-collection')?.refresh();
      return;
    }
    this._request?.abort();
    const requestId = ++this._requestId;
    this._error = '';
    this._activeSample = '';
    if (this._filterError) {
      this._result = null;
      this._loading = false;
      return;
    }
    const controller = new AbortController();
    this._request = controller;
    this._loading = true;
    try {
      const query: SearchQuery = {
        selection: this.selection ? structuredClone(this.selection) : null,
        filters: { ...this.filters },
        offset: this._offset,
        limit: this.pageSize,
      };
      // Validate here too: custom data adapters must never receive an invalid query.
      validateSearchQuery(query);
      if (this._sourceError) throw new Error(this._sourceError);
      if (!this._source) {
        this._result = null;
        return;
      }
      const result = await this._source.search(structuredClone(query), { signal: controller.signal });
      if (controller.signal.aborted || requestId !== this._requestId || !this.isConnected) return;
      this._result = structuredClone(result);
      this._biomes = [...new Set([...this._biomes, ...this._result.facets.biomes.map(facet => facet.value)])].sort();
      this.dispatchEvent(new CustomEvent('resultschange', {
        detail: { query: structuredClone(query), result: structuredClone(this._result) }, bubbles: true, composed: true,
      }));
    } catch (error) {
      if (controller.signal.aborted || requestId !== this._requestId || !this.isConnected) return;
      this._result = null;
      this._error = error instanceof Error ? error.message : 'The search could not be completed.';
      this.dispatchEvent(new CustomEvent('searcherror', {
        detail: { message: this._error }, bubbles: true, composed: true,
      }));
    } finally {
      if (requestId === this._requestId) this._loading = false;
    }
  }

  private onSelection(event: CustomEvent<SelectionChangeDetail>) {
    event.stopPropagation();
    this.setSelection(event.detail.geometry);
    this.dispatchEvent(new CustomEvent('selectionchange', {
      detail: { geometry: event.detail.geometry }, bubbles: true, composed: true,
    }));
  }

  private onMapSample(event: CustomEvent<SampleClickDetail>) {
    event.stopPropagation();
    this.chooseSample(event.detail.sample);
  }

  private chooseSample(sample: Sample) {
    this._activeSample = sample.accession;
    this.renderRoot.querySelector<SampleSiftMap>('sample-sift-map')?.selectSample(sample.accession);
    this.dispatchEvent(new CustomEvent('sampleclick', {
      detail: { accession: sample.accession, sample: structuredClone(sample) }, bubbles: true, composed: true,
    }));
  }

  private changePage(direction: number) {
    this._offset = Math.max(0, this._offset + direction * this.pageSize);
    void this.refresh();
  }

  private sourceUrl(sample: Sample): string | undefined {
    if (!sample.sourceUrl) return;
    try {
      const url = new URL(sample.sourceUrl);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
    } catch { return; }
  }

  private renderFilter(field: FilterField, filters: SampleFilters, biomeOptions: string[]) {
    const invalid = (key: keyof SampleFilters) => Boolean(this._filterError && key in this._filterDrafts);
    const numberValue = (value: number | null) => value !== null && Number.isFinite(value) ? String(value) : '';
    switch (field) {
      case 'n50': return html`
        <div class="filter-group">
          <label for="n50-min">Minimum N50 (bp)</label>
          <input id="n50-min" type="number" min="1" step="1" inputmode="numeric"
            .value=${numberValue(filters.n50MinBp)} aria-invalid=${invalid('n50MinBp')} aria-describedby="n50-help"
            @input=${(event: Event) => this.previewFilterInput('n50MinBp', event)} @change=${() => this.commitUserFilters()}>
          <label for="n50-max">Maximum N50 (bp)</label>
          <input id="n50-max" type="number" min="1" step="1" inputmode="numeric"
            .value=${numberValue(filters.n50MaxBp)} aria-invalid=${invalid('n50MaxBp')} aria-describedby="n50-help"
            @input=${(event: Event) => this.previewFilterInput('n50MaxBp', event)} @change=${() => this.commitUserFilters()}>
          <p class="field-note" id="n50-help">Assembly contig N50 in base pairs. Both bounds are inclusive.</p>
        </div>`;
      case 'taxonomy': return html`
        <div class="filter-group">
          <label for="taxon-id">Taxonomy ID</label>
          <input id="taxon-id" type="text" list="taxon-options" placeholder="ncbi:562" autocomplete="off" spellcheck="false"
            .value=${filters.taxonId ?? ''} aria-invalid=${invalid('taxonId')} aria-describedby="taxonomy-help"
            @input=${(event: Event) => this.previewFilterInput('taxonId', event)} @change=${() => this.commitUserFilters()}>
          <datalist id="taxon-options">${this.taxonomyOptions.map(option => html`<option value=${option.id} label=${option.label}></option>`)}</datalist>
          <label class="checkbox-label" for="taxon-descendants"><input id="taxon-descendants" type="checkbox"
            .checked=${filters.includeDescendants} @change=${(event: Event) => this.commitUserFilters({ includeDescendants: (event.target as HTMLInputElement).checked })}>Include descendant taxa</label>
          <p class="field-note" id="taxonomy-help">Use a namespaced identifier. Matching is exact unless descendants are included.</p>
        </div>`;
      case 'biome': return html`
        <div class="filter-group">
          <label for="biome">Biome</label>
          <select id="biome" @change=${(event: Event) => this.commitUserFilters({ biome: (event.target as HTMLSelectElement).value || null })}>
            <option value="" .selected=${!filters.biome}>All biomes</option>${biomeOptions.map(biome => html`<option value=${biome} .selected=${filters.biome === biome}>${biome}</option>`)}
          </select>
        </div>`;
      case 'collectionDate': return html`
        <div class="filter-group">
          <label for="date-from">Collected from</label>
          <input id="date-from" type="date" .value=${filters.dateFrom ?? ''} aria-invalid=${invalid('dateFrom')}
            @input=${(event: Event) => this.previewFilterInput('dateFrom', event)} @change=${() => this.commitUserFilters()}>
          <label for="date-to">Collected to</label>
          <input id="date-to" type="date" .value=${filters.dateTo ?? ''} aria-invalid=${invalid('dateTo')}
            @input=${(event: Event) => this.previewFilterInput('dateTo', event)} @change=${() => this.commitUserFilters()}>
          <p class="field-note">Date ranges include both endpoints. Samples with unknown dates are excluded when a date filter is active.</p>
        </div>`;
    }
  }

  private renderResults() {
    if (this._filterError) return html`<div class="empty error"><strong>Check your filters</strong><span>Correct the highlighted values or clear filters to continue.</span></div>`;
    if (this._loading) return html`<div class="empty loading"><span class="spinner"></span><strong>Searching samples…</strong><span>Applying your region and filters.</span></div>`;
    if (this._error) return html`<div class="empty error" role="alert"><strong>Search unavailable</strong><span>${this._error}</span><button @click=${() => this.refresh()}>Try again</button></div>`;
    if (!this._source) return html`<div class="empty"><strong>Connect a sample collection</strong><span>Set <code>api-url</code> or the <code>dataSource</code> property. Add <code>demo</code> to try synthetic sample data.</span></div>`;
    if (!this._result?.items.length) return html`<div class="empty"><strong>No samples in this search</strong><span>Try a larger region or clear a filter.</span></div>`;
    const hasAssemblyEvidence = this._result.items.some(sample => sample.assemblies?.length);
    return html`
      <div class="table-wrap">
        <table data-testid="results-table">
          <thead><tr><th scope="col">Sample</th><th scope="col">Biome</th><th scope="col">Collected</th><th scope="col">Coordinates</th>${hasAssemblyEvidence ? html`<th scope="col">Assembly evidence</th>` : nothing}</tr></thead>
          <tbody>${this._result.items.map(sample => html`
            <tr data-accession=${sample.accession} class=${this._activeSample === sample.accession ? 'active' : ''}>
              <td><button class="sample-link" aria-pressed=${this._activeSample === sample.accession} @click=${() => this.chooseSample(sample)}>${sample.accession}</button><span class="sample-title">${sample.title}</span>${this.sourceUrl(sample) ? html`<a class="source-link" href=${this.sourceUrl(sample) ?? nothing} target="_blank" rel="noopener noreferrer">Source ↗</a>` : nothing}</td>
              <td><span class="biome">${sample.biome}</span></td>
              <td class="nowrap">${sample.collectionDate ?? 'Unknown'}</td>
              <td class="coordinates">${sample.latitude.toFixed(3)}, ${sample.longitude.toFixed(3)}</td>
              ${hasAssemblyEvidence ? html`<td class="evidence-cell">${sample.assemblies?.length ? html`
                <details><summary>${sample.assemblies.length} ${sample.assemblies.length === 1 ? 'assembly' : 'assemblies'}</summary>
                  <ul>${sample.assemblies.map(assembly => html`<li><strong>${assembly.accession}</strong>
                    <span>N50: ${assembly.contigN50Bp === null ? 'Unknown' : `${assembly.contigN50Bp.toLocaleString()} bp`}</span>
                    <span>${assembly.taxa.length ? assembly.taxa.map(taxon => taxon.label ? `${taxon.label} (${taxon.id})` : taxon.id).join(', ') : 'No taxonomic evidence supplied'}</span>
                  </li>`)}</ul>
                </details>` : 'Not supplied'}</td>` : nothing}
            </tr>`)}
          </tbody>
        </table>
      </div>`;
  }

  render() {
    if (this._collectionConfig) return html`<sample-sift-collection
      .options=${this._collectionConfig} .filterMode=${this.filterMode} .filterDebounceMs=${this.filterDebounceMs} .state=${this.collectionState} .paused=${this.collectionPaused}
      .mapStyle=${this.mapStyle} .pageSize=${this.pageSize}
      @collectionstatechange=${this.onCollectionState}></sample-sift-collection>`;
    const result = this._result;
    const visibleItems = this._loading || this._error || this._filterError ? [] : result?.items ?? [];
    const filters: SampleFilters = { ...EMPTY_FILTERS, ...this.filters, ...this._filterDrafts };
    const filterFields = [...new Set(this.filterFields)];
    const activeHidden = [
      !filterFields.includes('n50') && (filters.n50MinBp !== null || filters.n50MaxBp !== null) ? 'N50' : '',
      !filterFields.includes('taxonomy') && filters.taxonId !== null ? 'taxonomy' : '',
      !filterFields.includes('biome') && filters.biome !== null ? 'biome' : '',
      !filterFields.includes('collectionDate') && (filters.dateFrom !== null || filters.dateTo !== null) ? 'collection date' : '',
    ].filter(Boolean);
    const total = result?.total ?? 0;
    const biomeOptions = [...new Set([...this._biomes, ...(filters.biome ? [filters.biome] : [])])];
    const selectedVertices = Math.max(0, (this.selection?.coordinates[0]?.length ?? 1) - 1);
    const isDemo = this.demo && !this.dataSource && !this.apiUrl.trim();
    return html`
      <div class="explorer">
        <aside class="filters" aria-label="Sample filters">
          <div class="section-kicker">YOUR SEARCH</div>
          <h2>Find your samples.</h2>
          <p class="intro">Draw a region on the map, then narrow it down.</p>
          <div class="region-card">
            <span class="region-icon" aria-hidden="true">⌖</span>
            <div><strong>${this.selection ? 'Region selected' : 'All locations'}</strong><span>${this.selection ? `${selectedVertices} vertices · boundaries included` : 'Use Rectangle or Polygon to select.'}</span></div>
            ${this.selection ? html`<button class="region-clear" aria-label="Clear selected region" @click=${() => { this.clearSelection(); this.dispatchEvent(new CustomEvent('selectionchange', {detail:{geometry:null},bubbles:true,composed:true})); }}>×</button>` : nothing}
          </div>
          ${this._filterError ? html`<p class="filter-error" role="alert">${this._filterError}</p>` : nothing}
          ${activeHidden.length ? html`<p class="field-note hidden-filters">Active filters without visible controls: ${activeHidden.join(', ')}. Clear filters removes them too.</p>` : nothing}
          ${filterFields.map(field => this.renderFilter(field, filters, biomeOptions))}
          <button class="reset" @click=${() => this.clearUserFilters()}>Clear filters</button>
          <div class="filter-footer"><span class="status-dot"></span>${isDemo ? 'Synthetic demonstration data' : this._source ? 'Connected collection' : 'Ready to connect'}<p>${isDemo ? 'These records are fictional. Connect the MGnify-backed API to explore real samples.' : 'The map previews the current results page. Counts cover the complete search.'}</p></div>
        </aside>
        <main>
          <section class="map-section" aria-label="Spatial selection">
            <sample-sift-map
              .samples=${visibleItems}
              .selection=${this.selection}
              .mapStyle=${this.mapStyle}
              @selectionchange=${this.onSelection}
              @sampleclick=${this.onMapSample}
            ></sample-sift-map>
            <div class="map-caption"><span class="point-key"></span>${this._loading ? 'Updating map preview…' : `${visibleItems.length} samples shown · current page only`}<span class="map-hint">Panning keeps your selection.</span></div>
          </section>
          <section class="results" aria-label="Matching samples" aria-busy=${this._loading}>
            <div class="results-heading">
              <div><span class="section-kicker">MATCHING SAMPLES</span><h3 data-testid="match-count" aria-live="polite">${this._filterError ? 'Check filters' : this._loading ? 'Searching…' : this._error ? 'Search unavailable' : !this._source ? 'No data source' : html`${total.toLocaleString()} <span>${total === 1 ? 'sample' : 'samples'}</span>`}</h3></div>
              <div class="facets">${!this._loading && !this._error && !this._filterError ? result?.facets.biomes.map(facet => html`<span>${facet.value}<b>${facet.count.toLocaleString()}</b></span>`) : nothing}</div>
            </div>
            ${this.renderResults()}
            <div class="pagination"><span>${this._loading ? 'Loading results' : visibleItems.length ? `${this._offset + 1}–${this._offset + visibleItems.length} of ${total.toLocaleString()}` : 'No rows to display'}</span><div><button aria-label="Previous page" ?disabled=${this._loading || !!this._filterError || !this._offset} @click=${() => this.changePage(-1)}>← Previous</button><button aria-label="Next page" ?disabled=${this._loading || !!this._filterError || !result || this._offset + this.pageSize >= total} @click=${() => this.changePage(1)}>Next →</button></div></div>
          </section>
        </main>
      </div>`;
  }

  static styles = css`
    :host{--samplesift-accent:#16674f;display:block;color:#233c34;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;color-scheme:light}
    *{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{outline-offset:3px}button{cursor:pointer}button:disabled{cursor:default;opacity:.38}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--samplesift-accent)}
    .explorer{display:grid;grid-template-columns:258px minmax(0,1fr);border:1px solid #dbe2da;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 8px 32px #173c2506}
    .filters{padding:28px 23px;background:#f8faf6;border-right:1px solid #e2e7df}.section-kicker{font-size:10px;font-weight:750;letter-spacing:.14em;color:#6e8074}h2{font-size:23px;line-height:1.2;letter-spacing:-.9px;font-weight:600;margin:12px 0}.intro{color:#758276;font-size:12px;margin:0 0 25px;max-width:190px}
    .region-card{display:flex;gap:11px;padding:14px 10px;background:#edf3e9;border:1px solid #dce6d5;border-radius:7px;align-items:center;margin-bottom:26px}.region-icon{font-size:25px;color:var(--samplesift-accent)}.region-card strong{font-size:12px;font-weight:650}.region-card span:not(.region-icon){display:block;font-size:10px;color:#6d7f69;margin-top:3px}.region-clear{background:none;border:0;font-size:22px;color:#5e7362;padding:0 3px;margin-left:auto}
    label{display:block;font-size:11px;font-weight:650;color:#526455;margin:18px 0 7px}input,select{width:100%;min-height:38px;padding:8px 10px;border:1px solid #d6ded3;border-radius:5px;background:white;color:#304b3c;font-size:12px}select{cursor:pointer}.field-note{color:#889184;font-size:10px;line-height:1.6;margin:12px 0 18px}.reset{width:100%;background:transparent;border:1px solid #ced8cb;color:#426148;padding:8px;border-radius:5px;font-size:11px}.reset:hover{background:#edf3e9}.filter-footer{font-size:10px;color:#6f7e68;margin-top:40px;padding-top:20px;border-top:1px solid #e0e7da}.filter-footer p{font-size:10px;color:#8b9485;margin:8px 0;line-height:1.65}.status-dot{display:inline-block;width:6px;height:6px;background:#7b995b;border-radius:50%;margin-right:6px}
    .filter-group{margin-bottom:14px;grid-column:1/-1}.filter-error{padding:10px;border:1px solid #dfb3a4;border-radius:5px;background:#fff4ed;color:#923f27;font-size:11px;grid-column:1/-1}input[aria-invalid=true]{border-color:#b56c52}.checkbox-label{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:500}.checkbox-label input{width:15px;min-height:15px;height:15px;margin:0;flex:none}.hidden-filters{padding:8px;border:1px solid #dbe2d3;border-radius:4px}
    main{min-width:0}.map-section{background:#e7eee5}sample-sift-map{display:block;height:410px}.map-caption{padding:9px 18px;border-top:1px solid #dce4d8;background:#fafcf8;display:flex;align-items:center;gap:7px;font-size:10px;color:#76846e;min-height:34px}.point-key{width:6px;height:6px;border-radius:50%;background:var(--samplesift-accent)}.map-hint{margin-left:auto;color:#96a08f}
    .results-heading{padding:22px 22px 17px;display:flex;gap:20px;justify-content:space-between;align-items:center}h3{margin:5px 0 0;font-size:27px;font-weight:600;letter-spacing:-1px;line-height:1.2}h3 span{font-size:15px;letter-spacing:0;font-weight:400;color:#8a9588;margin-left:4px}.facets{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}.facets>span{display:flex;gap:8px;border:1px solid #e5e9df;border-radius:4px;padding:4px 7px;font-size:9px;color:#77856e}.facets b{font-weight:600;color:#3b5e40}
    .table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}th{font-size:9px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#8b9684;background:#f8faf6;border-top:1px solid #edf0e7;border-bottom:1px solid #e6ecdf;padding:9px 20px;white-space:nowrap}td{padding:11px 20px;border-bottom:1px solid #edf1e7;color:#6b7e65}tr.active td{background:#f0f6eb}.sample-link{display:block;border:0;background:transparent;padding:0;color:var(--samplesift-accent);font-weight:650;font-size:11px;text-align:left}.sample-link:hover{text-decoration:underline}.sample-title{display:block;font-size:10px;margin-top:2px;color:#91a087;max-width:230px}.source-link{font-size:9px;color:#647e60}.biome{font-size:10px;border-radius:3px;padding:3px 7px;background:#f0f4eb;white-space:nowrap}.coordinates{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;white-space:nowrap}.nowrap{white-space:nowrap}.pagination{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 21px;font-size:10px;color:#8a9980}.pagination>div{display:flex;gap:7px}.pagination button{border:1px solid #dde5d5;border-radius:4px;padding:5px 10px;font-size:10px;background:white;color:#55704d}.pagination button:hover:enabled{background:#f0f5eb}
    .evidence-cell{min-width:120px;max-width:260px;font-size:10px}.evidence-cell summary{cursor:pointer;white-space:nowrap;color:#41684b}.evidence-cell ul{margin:8px 0 0;padding-left:14px;min-width:190px;overflow-wrap:anywhere}.evidence-cell li{margin-bottom:10px}.evidence-cell span{display:block;margin-top:4px}
    table{min-width:640px}.sample-link{white-space:nowrap}td:first-child{min-width:180px}
    .empty{min-height:170px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;text-align:center;padding:30px;color:#7e8d75;font-size:12px;border-top:1px solid #edf1e7}.empty strong{font-weight:550;font-size:15px;color:#415b3a}.empty>span{max-width:400px}.empty button{padding:6px 12px;border:1px solid #d0dac8;background:white;border-radius:4px;color:#45623b}.error{background:#fffaf5}.error strong{color:#965b34}.spinner{display:block;width:18px;height:18px;border:2px solid #e0e8d8;border-top-color:var(--samplesift-accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    @media(max-width:760px){.explorer{grid-template-columns:1fr}.filters{border-right:0;border-bottom:1px solid #e2e7df;padding:20px;display:grid;grid-template-columns:1fr 1fr;column-gap:16px}.filters>.section-kicker,.filters>h2,.filters>.intro,.region-card,.filter-footer,.field-note,.reset{grid-column:1/-1}.filters>.intro{max-width:none;margin-bottom:15px}.region-card{margin-bottom:0}.filters label{grid-column:1;align-self:center;margin:10px 0}.filters input,.filters select{grid-column:2;margin-top:8px}.filter-footer{margin-top:15px}.filter-footer p{margin-bottom:0}sample-sift-map{height:350px}.results-heading{padding:18px 15px}.map-hint{display:none}.facets{max-width:50%}td,th{padding-left:14px;padding-right:14px}}
  `;
}

if (!customElements.get('sample-sift')) customElements.define('sample-sift', SampleSift);

declare global { interface HTMLElementTagNameMap { 'sample-sift': SampleSift } }
