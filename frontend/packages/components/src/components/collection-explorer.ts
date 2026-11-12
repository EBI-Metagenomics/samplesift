import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import type { StyleSpecification } from 'maplibre-gl';
import type { MapLayerCatalog, MapLayerState } from '../map/layers';
import {
  buildCollectionQuery, createCollectionDataSource, createEmptyCollectionState, validateCollectionState,
} from '../collection/index';
import type {
  CollectionDataSource, CollectionItem, CollectionMetadata, CollectionOptions, CollectionResult,
  CollectionSearchState, Predicate,
} from '../collection/types';
import { fieldLabel, summarizeCollectionFilters } from '../collection/presentation';
import type { SampleSiftCollectionFilterForm } from './collection-filter-form';
import type { CollectionTileSource } from '../collection/tiles';
import type { SelectionChangeDetail } from '../types';
import type { SampleSiftMap } from './selection-map';
import { MAP_PARTS } from './selection-map';
import { FILTER_PARTS } from './collection-filter-form';
import { compactLayoutStyles, focusPanel, restorePanelFocus, reconcilePanelFocus, type ExplorerPanel } from './explorer-layout';

export const COLLECTION_PARTS = `compact-toolbar, panel-toggle, panel-heading, panel-close, compact-summary, explorer, filter-panel, region-summary, results, results-heading, results-count, results-table, table-container, table-head, table-header-cell, table-body, table-row, table-cell, record-link, sort-control, pagination, page-button, applied-filters, filter-chip, feature-details, status, error, empty-state, ${MAP_PARTS}, ${FILTER_PARTS}`;

/** Collection API coordinator. It never reads or writes the host's URL or history. */
export class SampleSiftCollection extends LitElement {
  static properties = {
    layout: { type: String }, showTable: { type: Boolean, attribute: 'show-table' }, _panel: { state: true },
    options: { attribute: false }, state: { attribute: false }, mapStyle: { attribute: false },
    mapLayers: { attribute: false }, mapLayerState: { attribute: false },
    pageSize: { type: Number }, paused: { type: Boolean },
    filterMode: { type: String, attribute: 'filter-mode' }, filterDebounceMs: { type: Number, attribute: 'filter-debounce-ms' },
    _restoreRevision: { state: true },
    _metadata: { state: true }, _result: { state: true }, _error: { state: true },
    _loading: { state: true }, _loadingMetadata: { state: true }, _offset: { state: true },
    _dirty: { state: true }, _tileSource: { state: true }, _activeFeature: { state: true },
  };
  layout: 'compact' | 'full' = 'compact';
  showTable = false;
  private _panel: ExplorerPanel | null = null;
  options?: CollectionOptions;
  state: CollectionSearchState = createEmptyCollectionState();
  mapStyle?: StyleSpecification | string;
  mapLayers?: MapLayerCatalog;
  mapLayerState?: MapLayerState;
  pageSize = 25;
  paused = false;
  filterMode: 'auto' | 'manual' = 'manual';
  filterDebounceMs = 500;
  private _restoreRevision = 0;
  private _metadata?: CollectionMetadata;
  private _result?: CollectionResult;
  private _error = '';
  private _loading = false;
  private _loadingMetadata = false;
  private _offset = 0;
  private _dirty = false;
  private _tileSource?: CollectionTileSource;
  private _tileKey = '';
  private _activeFeature?: Record<string, unknown>;
  private _source?: CollectionDataSource;
  private _metadataRequest?: AbortController;
  private _request?: AbortController;
  private _generation = 0;
  private _requestId = 0;

  get metadata(): CollectionMetadata | undefined { return this._metadata ? structuredClone(this._metadata) : undefined; }

  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) void this.initialize();
  }
  disconnectedCallback() {
    this._metadataRequest?.abort(); this._request?.abort();
    this._generation++; this._requestId++;
    super.disconnectedCallback();
  }
  protected willUpdate(changed: PropertyValues) {
    if (changed.has('layout') || changed.has('showTable')) {
      this._panel = reconcilePanelFocus(this, this._panel, this.layout, this.showTable);
      if (this._panel) this.renderRoot.querySelector<SampleSiftMap>('sample-sift-map')?.closeLayers();
    }
    if (changed.has('options')) { void this.initialize(); return; }
    if (changed.has('state') || changed.has('_metadata') || changed.has('pageSize') || changed.has('paused')) {
      this._offset = 0;
      if (this._metadata) void this.refresh();
    }
  }

  /** Restore an entire collection state silently. No user intent event is emitted. */
  setState(state: CollectionSearchState) {
    if (this._metadata) validateCollectionState(state, this._metadata, this.options?.spatial);
    this._dirty = false;
    this._restoreRevision++;
    if (JSON.stringify(this.state) !== JSON.stringify(state)) this.state = structuredClone(state);
  }

  private async initialize() {
    const generation = ++this._generation;
    this._restoreRevision++; this._dirty = false;
    this._metadataRequest?.abort(); this._request?.abort(); this._requestId++;
    this._metadata = undefined; this._source = undefined; this._result = undefined;
    this._tileSource = undefined; this._tileKey = ''; this._error = ''; this._loading = false;
    if (!this.options) { this._loadingMetadata = false; return; }
    this._loadingMetadata = true;
    const controller = new AbortController(); this._metadataRequest = controller;
    try {
      const source = createCollectionDataSource(structuredClone(this.options));
      const metadata = await source.metadata({ signal: controller.signal });
      if (controller.signal.aborted || generation !== this._generation || !this.isConnected) return;
      this._source = source;
      this._metadata = metadata;
      // Hosts can restore saved filters here. Set paused=true before mounting to gate initial search.
      this.dispatchEvent(new CustomEvent('collectionready', { detail: { metadata: structuredClone(metadata) }, bubbles: true, composed: true }));
    } catch (error) {
      if (controller.signal.aborted || generation !== this._generation || !this.isConnected) return;
      this.showError(error);
    } finally {
      if (generation === this._generation) this._loadingMetadata = false;
    }
  }

  private showError(error: unknown) {
    this._error = error instanceof Error ? error.message : 'Collection search failed.';
    this.dispatchEvent(new CustomEvent('searcherror', { detail: { message: this._error }, bubbles: true, composed: true }));
  }

  async refresh() {
    this._request?.abort(); const id = ++this._requestId;
    if (this.paused) {
      this._result = undefined; this._tileSource = undefined; this._tileKey = ''; this._loading = false;
      return;
    }
    if (!this._metadata || !this._source || !this.options) { this._loading = false; return; }
    this._loading = true; this._error = ''; this._activeFeature = undefined;
    const controller = new AbortController(); this._request = controller;
    let queryValidated = false;
    try {
      const state = structuredClone(this.state);
      const query = buildCollectionQuery(state, this._metadata, { limit: this.pageSize, offset: this._offset }, this.options.spatial);
      queryValidated = true;
      const body = query.filter ? { filter: query.filter } : {};
      const tileKey = JSON.stringify([this.options.tiles, body]);
      if (tileKey !== this._tileKey) {
        this._tileSource = this.options.tiles ? {
          urlTemplate: this._source.tileUrlTemplate, sourceLayer: this.options.tiles.sourceLayer,
          minZoom: this.options.tiles.minZoom, maxZoom: this.options.tiles.maxZoom, body,
        } : undefined;
        this._tileKey = tileKey;
      }
      const result = await this._source.search(query, { signal: controller.signal });
      if (controller.signal.aborted || id !== this._requestId || !this.isConnected) return;
      this._result = structuredClone(result);
      this.dispatchEvent(new CustomEvent('collectionresultschange', {
        detail: { state, query, result: structuredClone(result) }, bubbles: true, composed: true,
      }));
    } catch (error) {
      if (controller.signal.aborted || id !== this._requestId || !this.isConnected) return;
      if (!queryValidated) { this._result = undefined; this._tileSource = undefined; this._tileKey = ''; }
      this.showError(error);
    } finally { if (id === this._requestId) this._loading = false; }
  }

  private commit(state: CollectionSearchState) {
    if (!this._metadata) return;
    try {
      validateCollectionState(state, this._metadata, this.options?.spatial);
      if (JSON.stringify(state) === JSON.stringify(this.state)) return;
      // Map/sort commits must not replace the filter identity and erase a draft.
      const predicates = state.predicates === this.state.predicates ? this.state.predicates : structuredClone(state.predicates);
      this.state = { ...structuredClone(state), predicates };
      this.dispatchEvent(new CustomEvent('collectionstatechange', { detail: { state: structuredClone(this.state) }, bubbles: true, composed: true }));
    } catch (error) { this.showError(error); }
  }
  private onPredicates(event: CustomEvent<{ predicates: Predicate[] }>) {
    event.stopPropagation();
    this.commit({ ...this.state, predicates: event.detail.predicates });
  }
  private onDraft(event: CustomEvent<{ dirty: boolean; valid: boolean }>) {
    event.stopPropagation(); this._dirty = event.detail.dirty;
    // Drafts are local edits. The last committed request remains valid until a new commit supersedes it.
  }
  private onSelection(event: CustomEvent<SelectionChangeDetail>) {
    event.stopPropagation();
    if (this.paused) return;
    this.commit({ ...this.state, selection: event.detail.geometry });
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: structuredClone(event.detail), bubbles: true, composed: true }));
  }
  private clearRegion() {
    this.commit({ ...this.state, selection: null });
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { geometry: null }, bubbles: true, composed: true }));
  }
  private page(direction: number) {
    const stride = this._result?.limit ?? this.pageSize;
    const offset = this._result?.offset ?? this._offset;
    this._offset = Math.max(0, offset + direction * stride);
    void this.refresh();
  }
  private choose(item: CollectionItem) {
    this._activeFeature = structuredClone(item);
    this.renderRoot.querySelector<SampleSiftMap>('sample-sift-map')?.selectSample(item.source_pk);
    this.dispatchEvent(new CustomEvent('featureclick', {
      detail: { id: item.source_pk, properties: structuredClone(item), geometry: structuredClone(item.geometry) }, bubbles: true, composed: true,
    }));
  }
  private onFeature(event: CustomEvent<{ id: string; properties: Record<string, unknown> }>) {
    this._activeFeature = structuredClone(event.detail.properties);
    // Already a public, composed event; allow it through without emitting a duplicate.
  }
  private onMapLayerChange(event: CustomEvent<{ state: MapLayerState }>) {
    this.mapLayerState = structuredClone(event.detail.state);
  }
  private get filterForm() {
    return this.renderRoot.querySelector<SampleSiftCollectionFilterForm>('sample-sift-collection-filter-form');
  }
  private togglePanel(panel: ExplorerPanel) {
    if (panel === 'results' && !this.showTable) return;
    if (this._panel === panel) { this.closePanel(); return; }
    this.renderRoot.querySelector<SampleSiftMap>('sample-sift-map')?.closeLayers();
    this._panel = panel;
    focusPanel(this, panel);
  }
  private closePanel(restoreFocus = true) {
    const panel = this._panel;
    this._panel = null;
    if (panel && restoreFocus) restorePanelFocus(this, panel);
  }
  private readonly onPanelKeydown = {
    capture: true,
    handleEvent: (event: KeyboardEvent) => {
      const panel = this._panel;
      if (event.key !== 'Escape' || !panel) return;
      // Generated inputs stop bubbling. Wait until child pickers have had a
      // chance to consume Escape before closing the surrounding panel.
      setTimeout(() => {
        if (!event.defaultPrevented && this._panel === panel) this.closePanel();
      }, 0);
    },
  };
  private onLayerPanelChange(event: CustomEvent<{ open: boolean }>) {
    if (event.detail.open) this.closePanel(false);
  }
  private editFilter(name: string) {
    if (this.layout !== 'full') {
      this.renderRoot.querySelector<SampleSiftMap>('sample-sift-map')?.closeLayers();
      this._panel = 'filters';
    }
    void this.updateComplete.then(() => {
      this.filterForm?.editField(name);
      if (this.layout === 'full') this.filterForm?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  private removeFilter(name: string) { this.filterForm?.removeField(name); }
  private clearFilters() { this.filterForm?.clearFilters(); }

  private format(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  render() {
    const compact = this.layout !== 'full';
    const metadata = this._metadata;
    if (!metadata) return html`<section part="status" class=${compact ? 'setup compact-setup' : 'setup'} aria-busy=${this._loadingMetadata}>
      <h2>${this._loadingMetadata ? 'Loading collection…' : 'Connect a collection'}</h2>
      ${this._error ? html`<p role="alert">${this._error}</p><button @click=${() => this.initialize()}>Retry connection</button>` : html`<p>${this._loadingMetadata ? 'Discovering fields and supported operations.' : 'Provide a collection and API root to start.'}</p>`}
    </section>`;
    const modes: readonly ('rectangle' | 'polygon')[] = this.paused ? []
      : metadata.geometryField ? ['rectangle', 'polygon'] : this.options?.spatial ? ['rectangle'] : [];
    const items = this._result?.items ?? [];
    const total = this._result?.total;
    const pageLimit = this._result?.limit ?? this.pageSize;
    const pageOffset = this._result?.offset ?? this._offset;
    const disabled = this.paused || this._loading || Boolean(this._error);
    const chips = summarizeCollectionFilters(Array.isArray(this.state.predicates) ? this.state.predicates : [], metadata.fields);
    const nextDisabled = disabled || !this._result || (total === undefined ? items.length < pageLimit : pageOffset + pageLimit >= total);
    const columns = metadata.resultColumns;
    const count = this.paused ? 'Search paused' : !this._result && this._loading ? 'Finding records…'
      : !this._result && this._error ? 'Search unavailable' : total === undefined
        ? `${items.length} records on this page` : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`;
    const summary = [this.state.selection ? 'Selected region' : 'All locations', ...chips.map(chip => chip.summary)].join(' · ');
    return html`<div part="explorer" class=${compact ? 'explorer compact' : 'explorer'} @keydown=${this.onPanelKeydown}>
      <div class="compact-toolbar" part="compact-toolbar" ?hidden=${!compact}>
        <button type="button" part="panel-toggle" data-panel-toggle="filters" aria-label="Filters" aria-controls="collection-filters" aria-expanded=${this._panel === 'filters'} @click=${() => this.togglePanel('filters')}>Filters${chips.length ? html`<span class="badge">${chips.length}</span>` : nothing}</button>
        ${this.showTable ? html`<button type="button" part="panel-toggle" data-panel-toggle="results" aria-label="Results" aria-controls="collection-results-panel" aria-expanded=${this._panel === 'results'} @click=${() => this.togglePanel('results')}>Results</button>` : nothing}
        ${this._dirty ? html`<span class="draft-indicator">Unapplied changes</span>` : nothing}
        <span class="count" part="results-count" data-testid=${compact ? 'collection-count' : nothing} aria-live="polite" title=${count}>${count}</span>
      </div>
      <aside part="filter-panel" class="filters" id="collection-filters" data-panel="filters" tabindex="-1" aria-label="Collection filters" ?hidden=${compact && this._panel !== 'filters'}>
        <div class="panel-heading" part="panel-heading" ?hidden=${!compact}><h2 data-panel-heading tabindex="-1">Filters</h2><button type="button" part="panel-close" aria-label="Close filters" @click=${() => this.closePanel()}>Close</button></div>
        <div class="filter-content"><div class="filter-intro"><div class="kicker">COLLECTION</div><h2>${fieldLabel({ name: this.options?.collection ?? '' })}</h2><p class="intro">Refine the records shown on the map.</p></div>
        <div part="region-summary" class="region"><strong>${this.state.selection ? 'Region selected' : 'All locations'}</strong>
          <span>${metadata.geometryField ? 'Draw a rectangle or polygon on the map.' : this.options?.spatial ? 'Draw a rectangle on the map.' : 'This collection does not advertise a spatial filter.'}</span>
          ${this.state.selection ? html`<button ?disabled=${this.paused} @click=${this.clearRegion}>Clear region</button>` : nothing}
        </div>
        ${metadata.diagnostics.length ? html`<details class="notice"><summary>Collection capabilities</summary><ul>${metadata.diagnostics.map(issue => html`<li>${issue}</li>`)}</ul></details>` : nothing}
        <sample-sift-collection-filter-form exportparts=${FILTER_PARTS} .metadata=${metadata} .predicates=${this.state.predicates} .disabled=${this.paused}
          .autoApply=${this.filterMode === 'auto'} .debounceMs=${this.filterDebounceMs} .busy=${this._loading} .restoreRevision=${this._restoreRevision}
          @predicateschange=${this.onPredicates} @draftchange=${this.onDraft}></sample-sift-collection-filter-form></div>
      </aside>
      <main>
        <sample-sift-map exportparts=${MAP_PARTS} .tileSource=${this._tileSource} .selection=${this.state.selection} .selectionModes=${modes}
          .mapStyle=${this.mapStyle} .mapLayers=${this.mapLayers} .mapLayerState=${this.mapLayerState}
          @layerpanelchange=${this.onLayerPanelChange} @maplayerchange=${this.onMapLayerChange} @selectionchange=${this.onSelection} @featureclick=${this.onFeature}></sample-sift-map>
        <div class="caption">${this.options?.tiles ? 'The map shows all matching locations. Cluster labels count records; zoom in to explore.' : this.showTable ? 'No vector-tile layer configured. Records are available in the table.' : 'No collection map tiles configured.'}</div>
        ${this._activeFeature ? html`<details part="feature-details" class="feature" open><summary>Selected record</summary><button aria-label="Close record details" @click=${() => { this._activeFeature = undefined; }}>Close</button><dl>${Object.entries(this._activeFeature).filter(([key]) => !['geometry', 'cluster', 'cluster_id', 'point_count'].includes(key)).map(([key, value]) => html`<dt>${key}</dt><dd>${this.format(value)}</dd>`)}</dl></details>` : nothing}
        <section part="results" class="results" id="collection-results-panel" data-panel="results" tabindex="-1" aria-label="Collection results" aria-busy=${this._loading} ?hidden=${compact && (!this.showTable || this._panel !== 'results')}>
          <div class="panel-heading" part="panel-heading" ?hidden=${!compact}><h2 data-panel-heading tabindex="-1">Results</h2><button type="button" part="panel-close" aria-label="Close results" @click=${() => this.closePanel()}>Close</button></div>
          <div part="results-heading" class="heading"><div><div class="kicker">MATCHING RECORDS</div><div class="count-line"><h3 part="results-count" data-testid=${!compact ? 'collection-count' : nothing} aria-live="polite">${count}</h3>
              ${this._loading && this._result ? html`<span part="status" class="updating" role="status">Updating…</span>` : nothing}</div></div>
            ${this.showTable ? html`<label>Sort<select part="sort-control" aria-label="Sort records" ?disabled=${this.paused} .value=${this.state.sort[0] ?? ''} @change=${(event: Event) => this.commit({ ...this.state, sort: (event.target as HTMLSelectElement).value ? [(event.target as HTMLSelectElement).value] : [] })}>
              <option value="">Default order</option>${metadata.sortValues.map(value => html`<option value=${value}>${fieldLabel(metadata.fields.find(field => field.name === value.replace(/^-/, '')) ?? { name: value.replace(/^-/, '') })} ${value.startsWith('-') ? 'descending' : 'ascending'}</option>`)}
            </select></label>` : nothing}
          </div>
          ${chips.length || this.state.selection ? html`<div part="applied-filters" class="applied" aria-label="Applied filters">
            <div class="chips">${this.state.selection ? html`<span part="filter-chip" class="chip region-chip"><span>Selected region</span><button aria-label="Remove selected region" ?disabled=${this.paused} @click=${this.clearRegion}>×</button></span>` : nothing}
              ${chips.map(chip => html`<span part="filter-chip" class="chip"><button class="chip-edit" aria-label=${`Edit ${chip.label} filter`} aria-description=${chip.summary} title=${chip.summary} ?disabled=${this.paused} @click=${() => this.editFilter(chip.field)}>${chip.summary}</button><button aria-label=${`Remove applied ${chip.label} filter`} aria-description=${chip.summary} ?disabled=${this.paused} @click=${() => this.removeFilter(chip.field)}>×</button></span>`)}</div>
          </div>` : nothing}
          ${this._dirty ? html`<p part="status" class="draft-note" role="status">Showing applied filters while you edit.</p>` : nothing}
          ${this._error ? html`<div part="error" class="error" role="alert">${this._error}${this._result ? html`<p>Your previous results are still shown below.</p>` : nothing}<button @click=${() => this.refresh()}>Retry search</button></div>` : nothing}
          ${!this._loading && !this._error && !this.paused && !items.length ? html`<div part="empty-state" class="empty"><strong>No matching records</strong><p>Try widening a range or removing a filter.</p><div>
            ${chips.length ? html`<button @click=${this.clearFilters}>Clear attribute filters</button>` : nothing}
            ${this.state.selection ? html`<button @click=${this.clearRegion}>Clear selected region</button>` : nothing}
          </div></div>` : nothing}
          ${this.showTable && items.length && !this.paused ? html`<div part="table-container" class="table-wrap"><table part="results-table" data-testid="collection-results"><thead part="table-head"><tr>${columns.map(column => html`<th part="table-header-cell" scope="col">${column.title}</th>`)}</tr></thead><tbody part="table-body">
            ${items.map(item => html`<tr part="table-row" data-record-id=${item.source_pk} class=${this._activeFeature?.source_pk === item.source_pk ? 'selected' : ''}>${columns.map(column => html`<td part="table-cell">${column.name === 'source_pk' ? html`<button part="record-link" class="record-id" @click=${() => this.choose(item)}>${item.source_pk}</button>` : html`<span title=${this.format(item[column.name])}>${this.format(item[column.name])}</span>`}</td>`)}</tr>`)}
          </tbody></table></div>` : nothing}
          ${this.showTable ? html`<div part="pagination" class="pagination"><span>${items.length ? `${pageOffset + 1}–${pageOffset + items.length}${total === undefined ? '' : ` of ${total.toLocaleString()}`}` : 'No rows to display'}</span>
            <div><button part="page-button" aria-label="Previous collection page" ?disabled=${disabled || !pageOffset} @click=${() => this.page(-1)}>← Previous</button><button part="page-button" aria-label="Next collection page" ?disabled=${nextDisabled} @click=${() => this.page(1)}>Next →</button></div>
          </div>` : nothing}
        </section>
      </main>
      <div class="compact-summary" part="compact-summary" ?hidden=${!compact}>
        ${this._error ? html`<span class="summary-message summary-error" role="alert" title=${this._error}>Search failed: ${this._error}</span><button type="button" @click=${() => this.refresh()}>Retry search</button>`
          : html`<span class="summary-message" role="status" title=${summary}>${this._loading ? 'Updating results… · ' : ''}${summary}${this._dirty ? ' · Unapplied changes' : ''}${!this.options?.tiles ? ' · No map tiles configured' : ''}</span>`}
      </div>
    </div>`;
  }

  static styles = [css`
    :host{display:block;font:var(--samplesift-font-size, 13px)/var(--samplesift-line-height, 1.5) var(--samplesift-font, Inter,system-ui,sans-serif);color:var(--samplesift-text, #234033);color-scheme:var(--samplesift-color-scheme, light)}
    *{box-sizing:border-box}button,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}
    button{border:1px solid var(--samplesift-control-border-color, #d8e1d4);border-radius:var(--samplesift-control-radius, 5px);background:var(--samplesift-control-background, var(--samplesift-surface, white));padding:7px 11px;color:var(--samplesift-control-text, var(--samplesift-accent, #295d49))}
    button:focus-visible,select:focus-visible{outline:2px solid var(--samplesift-focus-color, var(--samplesift-accent, #16674f));outline-offset:3px}
    .explorer{display:grid;grid-template-columns:var(--samplesift-sidebar-width, 320px) minmax(0,1fr);border:1px solid var(--samplesift-border-color, #dbe2da);border-radius:var(--samplesift-radius, 14px);overflow:hidden;background:var(--samplesift-surface, white)}
    .filters{padding:var(--samplesift-panel-padding, 22px 18px);background:var(--samplesift-surface-muted, #f8faf6);border-right:1px solid var(--samplesift-border-color, #e1e7dc);min-width:0}
    .kicker{font-size:10px;letter-spacing:.14em;color:var(--samplesift-muted, #6f816f);font-weight:650}h2{font-size:24px;margin:7px 0 8px;overflow-wrap:anywhere}.intro{color:var(--samplesift-muted, #70816e);font-size:12px}.count-line{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.updating{font-size:11px;color:var(--samplesift-accent, #176d5c);background:var(--samplesift-surface-muted, #eaf4ee);border-radius:var(--samplesift-radius, 12px);padding:3px 9px}
    .region{display:grid;gap:7px;background:var(--samplesift-surface-muted, #edf3e9);border:1px solid var(--samplesift-border-color, #dce6d5);padding:13px;border-radius:var(--samplesift-radius, 7px);margin:20px 0}.region span{font-size:11px;color:var(--samplesift-muted, #63795f)}
    .region button{justify-self:start;font-size:11px}main{min-width:0}sample-sift-map{display:block;height:var(--samplesift-map-height, 420px)}.caption{padding:10px 18px;background:var(--samplesift-surface-muted, #f8faf6);color:var(--samplesift-muted, #71826c);font-size:11px;border-bottom:1px solid var(--samplesift-border-color, #e1e7dc)}
    .heading{padding:22px;display:flex;justify-content:space-between;gap:16px;align-items:center}h3{font-size:25px;font-weight:550;margin:7px 0 0;letter-spacing:-.5px}.heading label{font-size:11px;color:var(--samplesift-muted, #60775c);display:grid;gap:4px}select{max-width:180px;padding:6px;border:1px solid var(--samplesift-control-border-color, #d8e1d4);border-radius:var(--samplesift-control-radius, 5px);background:var(--samplesift-control-background, var(--samplesift-surface, white));color:var(--samplesift-control-text, var(--samplesift-accent, #295d49))}
    .applied{display:flex;align-items:flex-start;gap:10px;padding:0 22px 16px}.chips{display:flex;flex-wrap:wrap;gap:7px;flex:1;min-width:0}.chip{display:inline-flex;align-items:center;max-width:100%;border:1px solid var(--samplesift-border-color, #d5e5db);background:var(--samplesift-surface-muted, #eff6f1);border-radius:16px;color:var(--samplesift-accent, #285b48);font-size:11px;overflow:hidden}.chip button{border:0;background:transparent;padding:5px 9px;font-size:11px;border-radius:0;min-height:29px}.chip .chip-edit{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:310px;text-align:left}.chip button:last-child{font-size:17px;padding:2px 9px;border-left:1px solid var(--samplesift-border-color, #d5e5db)}.region-chip>span{padding:5px 10px}.draft-note{margin:0 22px 14px;color:var(--samplesift-muted, #71826c);font-size:11px}.empty strong{display:block;font-size:15px;color:var(--samplesift-text, #3d5746)}.empty p{margin:6px 0 13px}.empty>div{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
    .table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:11px;text-align:left}th{white-space:nowrap;text-transform:uppercase;letter-spacing:.06em;font-size:9px;color:var(--samplesift-muted, #718269);background:var(--samplesift-surface-muted, #f8faf6);padding:11px 14px;border-block:1px solid var(--samplesift-border-color, #e1e7dc)}td{padding:11px 14px;border-bottom:1px solid var(--samplesift-border-color, #e9eee5);max-width:220px;overflow-wrap:anywhere}td span{display:block;max-width:200px;max-height:6em;overflow:auto}.record-id{border:0;padding:0;font-size:10px;background:transparent;text-align:left;overflow-wrap:anywhere;min-width:130px}.selected{background:var(--samplesift-surface-muted, #edf5e9)}
    .pagination{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;gap:12px;font-size:11px;color:var(--samplesift-muted, #73836d)}.pagination>div{display:flex;gap:7px}.pagination button{font-size:11px}
    .notice{font-size:11px;color:var(--samplesift-warning-color, #806235);background:var(--samplesift-warning-background, #fff8e9);padding:10px 13px;margin:12px 0}.results>.notice{margin:0 20px 15px}.error{color:var(--samplesift-error-color, #963f28);background:var(--samplesift-error-background, #fff5ef);padding:18px}.error button{display:block;margin-top:10px}.empty{padding:28px;text-align:center;color:var(--samplesift-muted, #73836d)}
    .feature{padding:12px 20px;border-bottom:1px solid var(--samplesift-border-color, #dbe2da);background:var(--samplesift-surface-muted, #f4f8f0)}.feature summary{cursor:pointer;color:var(--samplesift-accent, #295d49)}.feature dl{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:5px 14px;font-size:11px}.feature dt{font-weight:600}.feature dd{margin:0;overflow-wrap:anywhere}
    .setup{padding:35px;border:1px solid var(--samplesift-border-color, #dbe2da);border-radius:var(--samplesift-radius, 12px);background:var(--samplesift-surface-muted, #f8faf6)}.setup [role=alert]{color:var(--samplesift-error-color, #963f28)}
    @media(max-width:760px){.explorer{grid-template-columns:1fr}.filters{border-right:0;border-bottom:1px solid var(--samplesift-border-color, #e1e7dc)}.heading{padding:17px;flex-wrap:wrap}sample-sift-map{height:var(--samplesift-map-height, 360px)}.pagination{padding:13px;flex-wrap:wrap}}
    .compact-setup{height:var(--samplesift-compact-height, 480px);min-height:360px}
  `, compactLayoutStyles];
}
if (!customElements.get('sample-sift-collection')) customElements.define('sample-sift-collection', SampleSiftCollection);
declare global { interface HTMLElementTagNameMap { 'sample-sift-collection': SampleSiftCollection } }
