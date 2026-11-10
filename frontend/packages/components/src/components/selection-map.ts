import { LitElement, css, html, unsafeCSS, type PropertyValues } from 'lit';
import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import mapLibreStyles from 'maplibre-gl/dist/maplibre-gl.css?inline';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import { isValidCoordinate, validatePolygon } from '../data/validation';
import type { Sample, SampleClickDetail, SelectionChangeDetail } from '../types';

type SelectionMode = 'rectangle' | 'polygon' | 'select';
const SAMPLE_SOURCE = 'samplesift-samples';
const SAMPLE_LAYER = 'samplesift-sample-points';
const SELECTION_SOURCE = 'samplesift-selection';

// Vite emits this worker beside the distributable, so the plain HTML build also works.
setWorkerUrl(mapLibreWorkerUrl);

/** Raster basemap for the demo. Consumers may supply their own MapLibre style. */
export const defaultMapStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.55 } }],
};

const emptyCollection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const clonePolygon = (polygon: Polygon): Polygon => ({
  type: 'Polygon',
  coordinates: polygon.coordinates.map((ring) => ring.map((position) => [...position])),
});

/** A framework-independent map; sample retrieval belongs to the host/data adapter. */
export class SampleSiftMap extends LitElement {
  static properties = {
    samples: { attribute: false },
    selection: { attribute: false },
    mapStyle: { attribute: false },
    _mode: { state: true },
    _ready: { state: true },
    _error: { state: true },
  };

  static styles = [unsafeCSS(mapLibreStyles), css`
    :host { display: block; position: relative; min-height: 360px; height: 100%; color: #173c3b; }
    * { box-sizing: border-box; }
    .surface { position: relative; height: 100%; min-height: inherit; overflow: hidden; background: #e8eff0; }
    .map { position: absolute; inset: 0; }
    .toolbar { position: absolute; z-index: 3; top: 16px; left: 16px; display: flex; gap: 4px; flex-wrap: wrap;
      max-width: calc(100% - 76px); padding: 5px; border: 1px solid #d4dedc; border-radius: 10px;
      background: rgba(255, 255, 255, 0.97); box-shadow: 0 3px 14px #102b2915; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px;
      border: 0; border-radius: 6px; padding: 7px 10px; background: transparent; color: #244742;
      font: 600 12px/1.2 var(--samplesift-font, system-ui, sans-serif); cursor: pointer; }
    button:hover { background: #edf4f1; }
    button[aria-pressed="true"] { background: #176d5c; color: white; }
    button:focus-visible { outline: 3px solid #e7ac48; outline-offset: 2px; }
    button:disabled { opacity: 0.42; cursor: not-allowed; }
    .clear { border-left: 1px solid #dce5e2; border-radius: 0 6px 6px 0; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; }
    .hint { position: absolute; z-index: 2; bottom: 30px; left: 16px; max-width: calc(100% - 32px);
      padding: 9px 12px; border: 1px solid #d6dfda; border-radius: 8px; background: rgba(255,255,255,.96);
      font: 500 12px/1.5 var(--samplesift-font, system-ui, sans-serif); box-shadow: 0 2px 12px #102b290d; }
    .hint.error { color: #953d2a; border-color: #e5baa9; }
    .maplibregl-ctrl-top-right { top: 6px; right: 6px; }
    .maplibregl-ctrl-attrib { font-size: 10px; }
    @media (max-width: 520px) {
      :host { min-height: 320px; }
      .toolbar { top: 10px; left: 10px; gap: 1px; }
      button { padding: 7px; }
      .hint { left: 10px; max-width: calc(100% - 20px); font-size: 11px; }
    }
  `];

  samples: Sample[] = [];
  selection: Polygon | null = null;
  mapStyle?: StyleSpecification | string;

  private _mode: SelectionMode = 'select';
  private _ready = false;
  private _error = '';
  private _map?: MapLibreMap;
  private _draw?: TerraDraw;
  private _resizeObserver?: ResizeObserver;
  private _selectedAccession?: string;
  private _selectionError = false;
  private _generation = 0;
  private _pendingFit = false;
  private _view?: { center: [number, number]; zoom: number };

  connectedCallback(): void {
    super.connectedCallback();
    // firstUpdated is not called again when the same custom element reconnects.
    void this.updateComplete.then(() => {
      if (this.isConnected) this._mountMap();
    });
  }

  disconnectedCallback(): void {
    this._unmountMap();
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has('mapStyle') && this._map) {
      this._unmountMap();
      this._mountMap();
      return;
    }
    if (changed.has('samples')) this._updateSamples();
    if (changed.has('selection')) {
      // A host-supplied region supersedes an unfinished gesture without emitting an event.
      if (this._draw?.enabled && this._mode !== 'select') this.setMode('select');
      this._updateSelection();
    }
  }

  /** Switch tools without changing the current committed selection. */
  setMode(mode: SelectionMode): void {
    if (!['rectangle', 'polygon', 'select'].includes(mode)) return;
    this._mode = mode;
    this._error = '';
    if (this._draw?.enabled) {
      this._draw.setMode('select');
      this._draw.clear();
      this._draw.setMode(mode);
    }
  }

  /** Clear is a user action and emits one selectionchange, even if invoked by a host button. */
  clearSelection(): void {
    this.setMode('select');
    this.selection = null;
    this._updateSelection();
    this._emitSelection(null);
  }

  /** Fit only the provided sample page, never implying coverage of the full result set. */
  fitSamples(): void {
    if (!this._map || !this._ready) {
      this._pendingFit = true;
      return;
    }
    const points = this.samples.filter((sample) => isValidCoordinate(sample.longitude, sample.latitude));
    if (!points.length) return;
    const longitudes = points.map((sample) => sample.longitude);
    const latitudes = points.map((sample) => Math.max(-85.05, Math.min(85.05, sample.latitude)));
    this._map.fitBounds([
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ], { padding: 64, maxZoom: 8, duration: 450 });
  }

  /** Highlight a sample without emitting sampleclick or issuing any requests. */
  selectSample(accession?: string): void {
    this._selectedAccession = accession;
    this._updatePointStyles();
  }

  private _mountMap(): void {
    if (this._map || !this.isConnected) return;
    const container = this.renderRoot.querySelector<HTMLElement>('.map');
    if (!container) return;
    container.replaceChildren();
    const generation = ++this._generation;
    this._ready = false;
    this._error = '';
    try {
      const map = new MapLibreMap({
        container,
        style: this.mapStyle ?? defaultMapStyle,
        center: this._view?.center ?? [12, 25],
        zoom: this._view?.zoom ?? 1.35,
        minZoom: 0.7,
        maxZoom: 18,
        bearing: 0,
        pitch: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
        attributionControl: { compact: true },
      });
      this._map = map;
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.getCanvas().setAttribute('aria-label', 'Sample locations map. Use arrow keys to pan and plus or minus to zoom.');
      map.on('error', () => {
        if (this._map !== map) return;
        this._error = 'Some map content could not load. Check your connection or map style.';
      });
      map.once('load', () => {
        if (generation !== this._generation || this._map !== map || !this.isConnected) return;
        try {
          map.setProjection({ type: 'mercator' });
          this._initialiseLayers(map);
          const draw = new TerraDraw({
            adapter: new TerraDrawMapLibreGLAdapter({ map }),
            modes: [new TerraDrawRectangleMode(), new TerraDrawPolygonMode(), new TerraDrawSelectMode()],
          });
          this._draw = draw;
          draw.on('finish', (id) => {
            const feature = draw.getSnapshotFeature(id);
            if (feature?.geometry.type !== 'Polygon') return;
            const geometry = clonePolygon(feature.geometry);
            // Wait until Terra Draw finishes its own commit before clearing transient drawing features.
            queueMicrotask(() => {
              if (this._draw !== draw || generation !== this._generation) return;
              try {
                validatePolygon(geometry);
                this.selection = geometry;
                this.setMode('select');
                this._updateSelection();
                this._emitSelection(geometry);
              } catch (error) {
                this.setMode('select');
                this._error = error instanceof Error ? error.message : 'This region is not valid. Please draw it again.';
              }
            });
          });
          draw.start();
          draw.setMode(this._mode);
          this._ready = true;
          this._updateSamples();
          this._updateSelection();
          if (this._pendingFit) {
            this._pendingFit = false;
            this.fitSamples();
          }
          this.dispatchEvent(new CustomEvent('map-ready', { bubbles: true, composed: true }));
        } catch (error) {
          this._error = error instanceof Error ? error.message : 'The map could not initialise.';
        }
      });
      this._resizeObserver = new ResizeObserver(() => {
        if (this._map === map) map.resize();
      });
      this._resizeObserver.observe(container);
    } catch (error) {
      this._error = error instanceof Error ? error.message : 'Your browser could not initialise the map.';
    }
  }

  private _initialiseLayers(map: MapLibreMap): void {
    map.addSource(SELECTION_SOURCE, { type: 'geojson', data: emptyCollection() });
    map.addLayer({
      id: 'samplesift-selection-fill', source: SELECTION_SOURCE, type: 'fill',
      paint: { 'fill-color': '#20856c', 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 'samplesift-selection-outline', source: SELECTION_SOURCE, type: 'line',
      paint: { 'line-color': '#18745f', 'line-width': 2.5, 'line-dasharray': [3, 2] },
    });
    map.addSource(SAMPLE_SOURCE, { type: 'geojson', data: emptyCollection(), promoteId: 'accession' });
    map.addLayer({
      id: SAMPLE_LAYER, source: SAMPLE_SOURCE, type: 'circle',
      paint: {
        'circle-radius': 5.5, 'circle-color': '#297c72', 'circle-opacity': 0.95,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6,
      },
    });
    map.on('click', SAMPLE_LAYER, this._onSampleClick);
    map.on('mouseenter', SAMPLE_LAYER, () => {
      if (this._mode === 'select') map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', SAMPLE_LAYER, () => {
      if (this._mode === 'select') map.getCanvas().style.cursor = '';
    });
  }

  private _onSampleClick = (event: MapLayerMouseEvent): void => {
    if (this._mode !== 'select') return;
    const accession = event.features?.[0]?.properties?.accession;
    const sample = this.samples.find((item) => item.accession === accession);
    if (!sample) return;
    this.selectSample(sample.accession);
    this.dispatchEvent(new CustomEvent<SampleClickDetail>('sampleclick', {
      detail: { accession: sample.accession, sample: structuredClone(sample) }, bubbles: true, composed: true,
    }));
  };

  private _updateSamples(): void {
    const source = this._map?.getSource(SAMPLE_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const data: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: this.samples
        .filter((sample) => isValidCoordinate(sample.longitude, sample.latitude))
        .map((sample) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [sample.longitude, sample.latitude] },
          properties: { accession: sample.accession },
        })),
    };
    source.setData(data);
    this._updatePointStyles();
  }

  private _updatePointStyles(): void {
    if (!this._map?.getLayer(SAMPLE_LAYER)) return;
    const selected = this._selectedAccession ?? '';
    this._map.setPaintProperty(SAMPLE_LAYER, 'circle-radius', ['case', ['==', ['get', 'accession'], selected], 8, 5.5]);
    this._map.setPaintProperty(SAMPLE_LAYER, 'circle-color', ['case', ['==', ['get', 'accession'], selected], '#d08531', '#297c72']);
  }

  private _updateSelection(): void {
    const source = this._map?.getSource(SELECTION_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    if (this.selection === null) {
      source.setData(emptyCollection());
      if (this._selectionError) this._error = '';
      this._selectionError = false;
      return;
    }
    try {
      validatePolygon(this.selection);
      source.setData({ type: 'Feature', geometry: clonePolygon(this.selection), properties: {} });
      if (this._selectionError) this._error = '';
      this._selectionError = false;
    } catch (error) {
      source.setData(emptyCollection());
      this._selectionError = true;
      this._error = error instanceof Error ? error.message : 'The supplied selection is not a valid polygon.';
    }
  }

  private _emitSelection(geometry: Polygon | null): void {
    this.dispatchEvent(new CustomEvent<SelectionChangeDetail>('selectionchange', {
      detail: { geometry: geometry ? clonePolygon(geometry) : null }, bubbles: true, composed: true,
    }));
  }

  private _unmountMap(): void {
    ++this._generation;
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    const map = this._map;
    if (map) this._view = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() };
    try {
      if (this._draw?.enabled) this._draw.stop();
    } catch {
      // Cleanup must still remove the map if a partially initialised adapter cannot stop.
    } finally {
      this._draw = undefined;
      this._map = undefined;
      map?.remove();
      this._ready = false;
    }
  }

  protected render() {
    const hint = this._error || (!this._ready ? 'Loading map…' : this._mode === 'rectangle'
      ? 'Click two opposite corners to select a rectangle.'
      : this._mode === 'polygon'
        ? 'Click to add corners. Click the first point to finish your polygon.'
        : this.selection ? 'Region selected. Draw a new region to replace it, or clear to search everywhere.'
          : 'Draw a rectangle or polygon to explore samples in a region.');
    return html`
      <div class="surface">
        <div class="map" part="map"></div>
        <div class="toolbar" role="group" aria-label="Map selection tools">
          <button type="button" aria-label="Pan map" aria-pressed=${this._mode === 'select'}
            ?disabled=${!this._ready} @click=${() => this.setMode('select')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3M15 7l3 3-3 3"/></svg>Pan
          </button>
          <button type="button" aria-pressed=${this._mode === 'rectangle'} ?disabled=${!this._ready}
            @click=${() => this.setMode('rectangle')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1"/></svg>Rectangle
          </button>
          <button type="button" aria-pressed=${this._mode === 'polygon'} ?disabled=${!this._ready}
            @click=${() => this.setMode('polygon')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 11-1 3 10-8 5-8-7Z"/></svg>Polygon
          </button>
          <button type="button" class="clear" ?disabled=${!this._ready || (!this.selection && this._mode === 'select')}
            @click=${() => this.clearSelection()}>Clear</button>
        </div>
        <div class="hint ${this._error ? 'error' : ''}" role="status" aria-live="polite">${hint}</div>
      </div>
    `;
  }
}

if (!customElements.get('sample-sift-map')) customElements.define('sample-sift-map', SampleSiftMap);

declare global {
  interface HTMLElementTagNameMap { 'sample-sift-map': SampleSiftMap }
}
