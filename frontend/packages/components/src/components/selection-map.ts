import { LitElement, css, html, nothing, unsafeCSS, type PropertyValues } from 'lit';
import {
  Map as MapLibreMap,
  NavigationControl,
  addProtocol,
  removeProtocol,
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
import { createCollectionTileLoader } from '../collection/tiles';
import type { CollectionFeatureClickDetail, CollectionTileSource } from '../collection/tiles';
import { defaultMapLayers, normalizeMapLayerState, validateMapLayerCatalog } from '../map/layers';
import type { MapLayerCatalog, MapLayerState, RasterMapLayer } from '../map/layers';
import { MANAGED_SOURCE_PREFIX, ManagedRasterLayers } from '../map/managed-layers';
import type { ManagedLayerStatus } from '../map/managed-layers';

/** Parts forwarded by the explorer wrappers; names are the public styling contract. */
export const MAP_PARTS = 'map, map-surface, map-toolbar, map-button, map-layer-toggle, map-layers-panel, map-layer-option, map-opacity, map-legend, map-status, map-retry';

type SelectionMode = 'rectangle' | 'polygon' | 'select';
const SAMPLE_SOURCE = 'samplesift-samples';
const SAMPLE_LAYER = 'samplesift-sample-points';
const SELECTION_SOURCE = 'samplesift-selection';
const CLUSTER_LAYER = 'samplesift-collection-clusters';
const CLUSTER_LABEL_LAYER = 'samplesift-collection-counts';
let tileProtocolSequence = 0;

// Resolve against the component server when embedded on another origin, such as Jupyter.
setWorkerUrl(new URL(mapLibreWorkerUrl, import.meta.url).href);

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

const managedMapStyle: StyleSpecification = {
  version: 8, sources: {},
  layers: [{ id: 'samplesift-background', type: 'background', paint: { 'background-color': '#e8eff0' } }],
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
    tileSource: { attribute: false },
    selectionModes: { attribute: false },
    selection: { attribute: false },
    mapStyle: { attribute: false },
    mapLayers: { attribute: false },
    mapLayerState: { attribute: false },
    _layersOpen: { state: true },
    _layerState: { state: true },
    _layerStatuses: { state: true },
    _layerConfigError: { state: true },
    _mode: { state: true },
    _ready: { state: true },
    _error: { state: true },
    _tilePending: { state: true },
    _tileRequestError: { state: true },
    _tileRenderError: { state: true },
    _tilesRendering: { state: true },
  };

  static styles = [unsafeCSS(mapLibreStyles), css`
    :host { display: block; position: relative; min-height: 360px; height: 100%; color: var(--samplesift-text, #173c3b); font-family: var(--samplesift-font, inherit); }
    * { box-sizing: border-box; }
    .surface { position: relative; container-type: inline-size; height: 100%; min-height: inherit; overflow: hidden; background: var(--samplesift-surface-muted, #e8eff0); }
    .map { position: absolute; inset: 0; }
    .toolbar { position: absolute; z-index: 3; top: 16px; left: 16px; display: flex; gap: 4px; flex-wrap: wrap;
      max-width: calc(100% - 76px); padding: 5px; border: 1px solid var(--samplesift-border-color, #d4dedc); border-radius: var(--samplesift-radius, 10px);
      background: var(--samplesift-surface, rgba(255, 255, 255, 0.97)); box-shadow: 0 3px 14px #102b2915; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px;
      border: 0; border-radius: var(--samplesift-control-radius, 6px); padding: 7px 10px; background: var(--samplesift-control-background, transparent); color: var(--samplesift-control-text, var(--samplesift-text, #244742));
      font: 600 12px/1.2 var(--samplesift-font, system-ui, sans-serif); cursor: pointer; }
    button:hover { background: var(--samplesift-surface-muted, #edf4f1); }
    button[aria-pressed="true"] { background: var(--samplesift-accent, #176d5c); color: var(--samplesift-on-accent, white); }
    button[aria-pressed="true"]:hover { background: var(--samplesift-accent-hover, var(--samplesift-accent, #176d5c)); }
    button:focus-visible { outline: 3px solid var(--samplesift-focus-color, #e7ac48); outline-offset: 2px; }
    button:disabled { opacity: 0.42; cursor: not-allowed; }
    .clear { border-left: 1px solid var(--samplesift-border-color, #dce5e2); border-radius: 0 var(--samplesift-control-radius, 6px) var(--samplesift-control-radius, 6px) 0; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; }
    .hint { position: absolute; z-index: 2; bottom: 30px; left: 16px; max-width: calc(100% - 32px);
      padding: 9px 12px; border: 1px solid var(--samplesift-border-color, #d6dfda); border-radius: var(--samplesift-radius, 8px); background: var(--samplesift-surface, rgba(255,255,255,.96));
      font: 500 12px/1.5 var(--samplesift-font, system-ui, sans-serif); box-shadow: 0 2px 12px #102b290d; }
    .hint.error { color: var(--samplesift-error-color, #953d2a); border-color: var(--samplesift-error-color, #e5baa9); background: var(--samplesift-error-background, var(--samplesift-surface, rgba(255,255,255,.96))); }
    .tile-status { display: flex; align-items: center; gap: 10px; }
    .tile-status.error { align-items: flex-start; }
    .tile-status strong { display: block; }
    .tile-status p { margin: 3px 0 7px; font-weight: 400; }
    .tile-status small { display: block; max-width: 280px; margin-top: 3px; font-size: 11px; font-weight: 400; }
    .retry { border: 1px solid currentColor; background: var(--samplesift-control-background, var(--samplesift-surface, white)); color: var(--samplesift-error-color, #953d2a); }
    .spinner { flex: 0 0 auto; width: 15px; height: 15px; border: 2px solid var(--samplesift-border-color, #bfd9d0);
      border-top-color: var(--samplesift-accent, #176d5c); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    .layer-controls { position: absolute; z-index: 4; right: 60px; top: 16px; display: flex; flex-direction: column; align-items: flex-end; max-width: calc(100% - 32px); max-height: calc(100% - 51px); }
    .layers-toggle { flex: 0 0 auto; background: var(--samplesift-control-background, var(--samplesift-surface, #fff)); border: 1px solid var(--samplesift-control-border-color, var(--samplesift-border-color, #cbdad3)); box-shadow: 0 2px 10px #102b2918; }
    .layers-toggle .layer-warning { color: var(--samplesift-error-color, #953d2a); }
    .layers-panel { min-height: 0; flex: 1 1 auto; width: 292px; max-width: 100%; max-height: min(380px, calc(100vh - 220px)); overflow-y: auto; margin-top: 14px; padding: var(--samplesift-panel-padding, 14px); border: 1px solid var(--samplesift-border-color, #cbdad3); border-radius: var(--samplesift-radius, 9px); background: var(--samplesift-surface, rgba(255,255,255,.98)); box-shadow: 0 3px 16px #102b2925; font: 12px/1.45 var(--samplesift-font, system-ui, sans-serif); }
    .layers-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; } .layers-heading h3 { font: 650 13px/1.3 var(--samplesift-font, system-ui, sans-serif); margin: 0; }
    .layers-close { padding: 2px 6px; min-height: 26px; font-size: 18px; }
    .layers-panel fieldset { margin: 0; padding: 0; border: 0; min-width: 0; } .layers-panel legend { font-weight: 650; margin-bottom: 6px; padding: 0; }
    .layer-choice { display: flex; align-items: flex-start; gap: 7px; padding: 5px 0; cursor: pointer; }
    .layer-choice input { margin: 2px 0 0; accent-color: var(--samplesift-accent, #176d5c); flex: 0 0 auto; } .layer-choice small { display: block; margin-top: 2px; color: var(--samplesift-muted, #687d72); font-size: 10px; line-height: 1.4; }
    .layer-choice strong { font-weight: 550; } .layer-choice input:focus-visible, .layer-opacity input:focus-visible { outline: 2px solid var(--samplesift-focus-color, var(--samplesift-accent, #176d5c)); outline-offset: 2px; }
    .layer-overlays { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--samplesift-border-color, #dce5df); } .layer-opacity { display: block; padding: 4px 0 4px 20px; } .layer-opacity span { display: flex; align-items: center; justify-content: space-between; } .layer-opacity input { display: block; width: 100%; margin: 5px 0; accent-color: var(--samplesift-accent, #176d5c); }
    .layer-legend { margin: 5px 0 8px 20px; } .layer-legend summary { cursor: pointer; font-size: 11px; color: var(--samplesift-muted, #3c6251); } .layer-legend ul { list-style: none; padding: 4px 0 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; } .layer-legend li { display: flex; align-items: center; gap: 5px; font-size: 10px; } .layer-swatch { width: 10px; height: 10px; border: 1px solid var(--samplesift-border-color, #70807850); flex: 0 0 auto; }
    .provider-status { margin: 4px 0 6px 20px; color: var(--samplesift-muted, #667d70); font-size: 11px; } .provider-status.error { color: var(--samplesift-error-color, #953d2a); background: var(--samplesift-error-background, transparent); } .provider-status button { min-height: 26px; padding: 3px 6px; margin-top: 4px; color: inherit; border: 1px solid var(--samplesift-control-border-color, var(--samplesift-border-color, #d3b5a8)); font-size: 11px; } .provider-status p { margin: 0; }
    .layers-notice { max-width: 235px; margin-top: 6px; background: var(--samplesift-error-background, var(--samplesift-surface, #fff)); border: 1px solid var(--samplesift-border-color, #dec7b7); border-radius: var(--samplesift-control-radius, 6px); padding: 6px 9px; font-size: 11px; line-height: 1.4; color: var(--samplesift-error-color, #953d2a); }
    @container (max-width: 519px) {
      .layer-controls { right: 10px; top: 92px; max-width: calc(100% - 20px); max-height: calc(100% - 127px); }
      .layers-panel { width: 262px; max-height: 205px; padding: var(--samplesift-panel-padding, 11px); }
    }
    @container (max-width: 360px) {
      .layer-controls { top: 106px; max-height: calc(100% - 141px); }
    }
    .maplibregl-map { font-family: var(--samplesift-font, Helvetica Neue, Arial, Helvetica, sans-serif); }
    .maplibregl-ctrl-group { background: var(--samplesift-control-background, var(--samplesift-surface, #fff)); border-radius: var(--samplesift-control-radius, 4px); }
    .maplibregl-ctrl-group button:focus:first-child { border-radius: var(--samplesift-control-radius, 4px) var(--samplesift-control-radius, 4px) 0 0; }
    .maplibregl-ctrl-group button:focus:last-child { border-radius: 0 0 var(--samplesift-control-radius, 4px) var(--samplesift-control-radius, 4px); }
    .maplibregl-ctrl-group button:focus:only-child { border-radius: inherit; }
    .maplibregl-ctrl-top-right { top: 6px; right: 6px; }
    .maplibregl-ctrl-attrib { font-size: 10px; }
    @media (max-width: 520px) { :host { min-height: 320px; } }
    @container (max-width: 520px) {
      .toolbar { top: 10px; left: 10px; gap: 1px; }
      button { padding: 7px; }
      .hint { left: 10px; max-width: calc(100% - 20px); font-size: 11px; }
    }
  `];

  samples: Sample[] = [];
  tileSource: CollectionTileSource | undefined;
  selectionModes: readonly ('rectangle' | 'polygon')[] = ['rectangle', 'polygon'];
  selection: Polygon | null = null;
  mapStyle?: StyleSpecification | string;
  mapLayers?: MapLayerCatalog;
  mapLayerState?: MapLayerState;

  private _layersOpen = false;
  private _layerCatalog?: MapLayerCatalog;
  private _layerState?: MapLayerState;
  private _layerStatuses: ManagedLayerStatus[] = [];
  private _layerConfigError = '';
  private _managedLayers?: ManagedRasterLayers;

  private _mode: SelectionMode = 'select';
  private _tileProtocol = `samplesift-${Date.now().toString(36)}-${++tileProtocolSequence}-${Math.random().toString(36).slice(2)}`;
  private _tilePending = 0;
  private _tileRequestError = '';
  private _tileRenderError = '';
  private _tilesRendering = false;
  private _hasLoadedTiles = false;
  private _tileRevision = 0;
  private _tileStatusSnapshot = '';
  private _tileLoader = createCollectionTileLoader(this._tileProtocol, globalThis.fetch, {
    requestDelayMs: 150,
    onStatus: (status) => {
      this._tileRevision = status.revision;
      this._tilePending = status.pending;
      this._tileRequestError = status.error ?? '';
    },
  });
  private _tileProtocolRegistered = false;
  private _collectionSourceId: string | undefined;
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
    if (changed.has('mapLayers') || changed.has('mapLayerState') || changed.has('mapStyle')) this._resolveMapLayers();
    if (changed.has('selectionModes') && this._mode !== 'select' && !this.selectionModes.includes(this._mode)) this.setMode('select');
    if (changed.has('mapStyle') && this._map) {
      this._unmountMap();
      this._mountMap();
      return;
    }
    if (changed.has('tileSource') && this._ready) this._replaceDataLayers();
    if (changed.has('samples')) this._updateSamples();
    if (changed.has('selection')) {
      // A host-supplied region supersedes an unfinished gesture without emitting an event.
      if (this._draw?.enabled && this._mode !== 'select') this.setMode('select');
      this._updateSelection();
    }
    this.emitTileStatus();
  }

  private emitTileStatus(): void {
    if (!this.tileSource && !this._tileStatusSnapshot) return;
    const loading = Boolean(this.tileSource && (this._tilePending > 0 || this._tilesRendering));
    const error = this._tileRequestError || this._tileRenderError || null;
    const detail = {
      loading, pending: this._tilePending, error, revision: this._tileRevision,
      ready: Boolean(this.tileSource && this._hasLoadedTiles && !loading && !error),
      query: this.tileSource?.body ?? null,
    };
    const snapshot = JSON.stringify(detail);
    if (snapshot === this._tileStatusSnapshot) return;
    this._tileStatusSnapshot = snapshot;
    this.dispatchEvent(new CustomEvent('collectiontileschange', {
      detail: structuredClone(detail), bubbles: true, composed: true,
    }));
  }

  /** Switch tools without changing the current committed selection. */
  setMode(mode: SelectionMode): void {
    if (!['rectangle', 'polygon', 'select'].includes(mode)) return;
    if (mode !== 'select' && !this.selectionModes.includes(mode)) return;
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
    if (this.tileSource) return;
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
    this._resolveMapLayers();
    const generation = ++this._generation;
    this._ready = false;
    this._error = '';
    try {
      const map = new MapLibreMap({
        container,
        style: this.mapStyle ?? managedMapStyle,
        center: this._view?.center ?? [12, 25],
        zoom: this._view?.zoom ?? 1.35,
        minZoom: 0.7,
        maxZoom: 18,
        bearing: 0,
        fadeDuration: 0,
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
      map.on('error', (event) => {
        if (this._map !== map || (event.error as { name?: string } | undefined)?.name === 'AbortError') return;
        const sourceId = (event as unknown as { sourceId?: string }).sourceId;
        // Contextual providers have their own loading, error and retry UI.
        if (sourceId?.startsWith(MANAGED_SOURCE_PREFIX)) return;
        if (sourceId === this._collectionSourceId && this._collectionSourceId) {
          // Transport failures already carry a useful message. Decode/render failures
          // also need the same retry path, without being confused with basemap errors.
          if (!this._tileRequestError) this._tileRenderError = 'Location tiles could not be displayed. Retry to load locations.';
          this._tilesRendering = false;
          return;
        }
        // Late failures from a removed collection revision are irrelevant.
        if (sourceId?.startsWith('samplesift-collection-')) return;
        this._error = 'Some map content could not load. Check your connection or map style.';
      });
      map.on('sourcedataloading', (event) => {
        if (this._map === map && event.sourceId === this._collectionSourceId) this._tilesRendering = true;
      });
      const updateTileLoading = (event: { sourceId: string }) => {
        if (this._map !== map || !this._collectionSourceId || event.sourceId !== this._collectionSourceId) return;
        this._tilesRendering = !map.isSourceLoaded(this._collectionSourceId);
        if (!this._tilesRendering && !this._tileRequestError && !this._tileRenderError) this._hasLoadedTiles = true;
      };
      map.on('sourcedata', updateTileLoading);
      map.on('sourcedataabort', updateTileLoading);
      map.once('load', () => {
        if (generation !== this._generation || this._map !== map || !this.isConnected) return;
        try {
          map.setProjection({ type: 'mercator' });
          this._initialiseLayers(map);
          this._managedLayers = new ManagedRasterLayers(map,
            statuses => { if (this._map === map) this._layerStatuses = statuses; },
            (id, message) => { if (this._map === map) this.dispatchEvent(new CustomEvent('maplayererror', {
              detail: { id, message }, bubbles: true, composed: true,
            })); },
          );
          this._managedLayers.update(this._layerCatalog, this._layerState);
          const draw = new TerraDraw({
            adapter: new TerraDrawMapLibreGLAdapter({ map }),
            modes: [new TerraDrawRectangleMode(), new TerraDrawPolygonMode(), new TerraDrawSelectMode()],
          });
          this._draw = draw;
          draw.on('finish', (id) => {
            const feature = draw.getSnapshotFeature(id);
            if (feature?.geometry.type !== 'Polygon') return;
            const geometry = clonePolygon(feature.geometry);
            const completedMode = this._mode;
            // Wait until Terra Draw finishes its own commit before clearing transient drawing features.
            queueMicrotask(() => {
              if (this._draw !== draw || generation !== this._generation) return;
              if (completedMode !== 'select' && !this.selectionModes.includes(completedMode)) return;
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
    this._replaceDataLayers();
    map.on('click', SAMPLE_LAYER, this._onSampleClick);
    map.on('click', CLUSTER_LAYER, this._onClusterClick);
    for (const layer of [SAMPLE_LAYER, CLUSTER_LAYER]) {
      map.on('mouseenter', layer, () => {
        if (this._mode === 'select') map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layer, () => {
        if (this._mode === 'select') map.getCanvas().style.cursor = '';
      });
    }
  }

  /** Replace only data layers, preserving the viewport, drawing tools and committed region. */
  private _replaceDataLayers(): void {
    const map = this._map;
    if (!map) return;
    this._tileLoader.clear();
    this._tileRenderError = '';
    this._tilesRendering = false;
    this._hasLoadedTiles = false;
    for (const layer of [CLUSTER_LABEL_LAYER, CLUSTER_LAYER, SAMPLE_LAYER]) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    if (this._collectionSourceId && map.getSource(this._collectionSourceId)) map.removeSource(this._collectionSourceId);
    if (map.getSource(SAMPLE_SOURCE)) map.removeSource(SAMPLE_SOURCE);
    this._collectionSourceId = undefined;
    this._error = '';
    try {
      if (this.tileSource) {
        const tile = this._tileLoader.setSource(this.tileSource);
        if (!this._tileProtocolRegistered) {
          addProtocol(this._tileProtocol, this._tileLoader.load);
          this._tileProtocolRegistered = true;
        }
        const sourceId = `samplesift-collection-${tile.revision}`;
        this._collectionSourceId = sourceId;
        this._tilesRendering = true;
        map.addSource(sourceId, {
          type: 'vector', tiles: [tile.urlTemplate],
          minzoom: tile.minZoom, maxzoom: tile.maxZoom,
          promoteId: 'source_pk',
        });
        map.addLayer({
          id: SAMPLE_LAYER, source: sourceId, 'source-layer': tile.sourceLayer, type: 'circle',
          filter: ['!=', ['get', 'cluster'], true],
          paint: {
            'circle-radius': 5.5, 'circle-color': '#297c72', 'circle-opacity': 0.95,
            'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6,
          },
        });
        map.addLayer({
          id: CLUSTER_LAYER, source: sourceId, 'source-layer': tile.sourceLayer, type: 'circle',
          filter: ['==', ['get', 'cluster'], true],
          paint: {
            'circle-radius': ['step', ['to-number', ['get', 'point_count'], 0], 16, 100, 20, 1000, 25],
            'circle-color': '#176d5c', 'circle-opacity': 0.94,
            'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
          },
        });
        map.addLayer({
          id: CLUSTER_LABEL_LAYER, source: sourceId, 'source-layer': tile.sourceLayer, type: 'symbol',
          filter: ['==', ['get', 'cluster'], true],
          layout: {
            'text-field': ['to-string', ['get', 'point_count']], 'text-font': ['sans-serif'],
            'text-size': 11, 'text-allow-overlap': false,
          },
          paint: { 'text-color': '#ffffff' },
        });
      } else {
        if (this._tileProtocolRegistered) {
          removeProtocol(this._tileProtocol);
          this._tileProtocolRegistered = false;
        }
        map.addSource(SAMPLE_SOURCE, { type: 'geojson', data: emptyCollection(), promoteId: 'accession' });
        map.addLayer({
          id: SAMPLE_LAYER, source: SAMPLE_SOURCE, type: 'circle',
          paint: {
            'circle-radius': 5.5, 'circle-color': '#297c72', 'circle-opacity': 0.95,
            'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6,
          },
        });
        this._updateSamples();
      }
      this._updatePointStyles();
    } catch (error) {
      this._tilesRendering = false;
      if (this.tileSource) this._tileRenderError = error instanceof Error ? error.message : 'Location tiles could not be loaded.';
      else this._error = error instanceof Error ? error.message : 'The map data source could not initialise.';
    }
  }

  /** Re-fetch the current filtered tiles while preserving the camera and selection. */
  retryTiles(): void {
    if (!this.tileSource || !this._ready) return;
    this._replaceDataLayers();
  }

  private _onClusterClick = (event: MapLayerMouseEvent): void => {
    if (this._mode !== 'select' || !this._map) return;
    const geometry = event.features?.[0]?.geometry;
    if (geometry?.type !== 'Point') return;
    const [longitude, latitude] = geometry.coordinates;
    this._map.easeTo({
      center: [longitude, latitude],
      zoom: Math.min(this._map.getZoom() + 2, this._map.getMaxZoom()), duration: 300,
    });
  };

  private _onSampleClick = (event: MapLayerMouseEvent): void => {
    if (this._mode !== 'select') return;
    if (this._collectionSourceId) {
      const feature = event.features?.[0];
      const id = feature?.properties?.source_pk;
      if (!feature || (typeof id !== 'string' && typeof id !== 'number')) return;
      this.selectSample(String(id));
      this.dispatchEvent(new CustomEvent<CollectionFeatureClickDetail>('featureclick', {
        detail: { id: String(id), properties: structuredClone(feature.properties), geometry: structuredClone(feature.geometry) },
        bubbles: true, composed: true,
      }));
      return;
    }
    const accession = event.features?.[0]?.properties?.accession;
    const sample = this.samples.find((item) => item.accession === accession);
    if (!sample) return;
    this.selectSample(sample.accession);
    this.dispatchEvent(new CustomEvent<SampleClickDetail>('sampleclick', {
      detail: { accession: sample.accession, sample: structuredClone(sample) }, bubbles: true, composed: true,
    }));
  };

  private _updateSamples(): void {
    if (this.tileSource) return;
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
    const property = this._collectionSourceId ? 'source_pk' : 'accession';
    this._map.setPaintProperty(SAMPLE_LAYER, 'circle-radius', ['case', ['==', ['get', property], selected], 8, 5.5]);
    this._map.setPaintProperty(SAMPLE_LAYER, 'circle-color', ['case', ['==', ['get', property], selected], '#d08531', '#297c72']);
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
    this._managedLayers?.destroy();
    this._managedLayers = undefined;
    this._layerStatuses = [];
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
      try {
        map?.remove();
      } finally {
        this._tileLoader.clear();
        this._tileRenderError = '';
        this._tilesRendering = false;
        this._hasLoadedTiles = false;
        this._collectionSourceId = undefined;
        if (this._tileProtocolRegistered) {
          removeProtocol(this._tileProtocol);
          this._tileProtocolRegistered = false;
        }
        this._ready = false;
      }
    }
  }

  /** Restore presentation preferences silently; they never enter the collection query. */
  private _resolveMapLayers(): void {
    try {
      const catalog = this.mapLayers ?? (this.mapStyle === undefined ? defaultMapLayers : undefined);
      if (catalog) validateMapLayerCatalog(catalog);
      this._layerCatalog = catalog;
      this._layerState = catalog ? normalizeMapLayerState(this.mapLayerState, catalog) : undefined;
      this._layerConfigError = '';
      if (!catalog?.basemaps.length && !catalog?.overlays?.length) this._layersOpen = false;
      this._managedLayers?.update(catalog, this._layerState);
    } catch (error) {
      this._layerCatalog = undefined;
      this._layerState = undefined;
      this._layerConfigError = error instanceof Error ? error.message : 'Map layer options are invalid.';
      this._managedLayers?.update(undefined, undefined);
    }
  }

  private _changeMapLayers(state: MapLayerState): void {
    if (!this._layerCatalog) return;
    const next = normalizeMapLayerState(state, this._layerCatalog);
    if (JSON.stringify(next) === JSON.stringify(this._layerState)) return;
    this.mapLayerState = structuredClone(next);
    this._layerState = next;
    this._managedLayers?.update(this._layerCatalog, next);
    this.dispatchEvent(new CustomEvent('maplayerchange', {
      detail: { state: structuredClone(next) }, bubbles: true, composed: true,
    }));
  }

  /** Retry a contextual provider without recreating the map or the collection source. */
  retryMapLayer(id: string): void {
    this._managedLayers?.retry(id);
    this._managedLayers?.update(this._layerCatalog, this._layerState);
  }

  /** Close the layer panel without changing its selection or emitting user intent. */
  closeLayers(restoreFocus = false): void {
    if (!this._layersOpen) return;
    this._layersOpen = false;
    if (restoreFocus) void this.updateComplete.then(() => {
      if (!this._layersOpen) this.renderRoot.querySelector<HTMLButtonElement>('.layers-toggle')?.focus({ preventScroll: true });
    });
  }

  private _closeLayers(): void {
    if (!this._layersOpen) return;
    this.closeLayers(true);
    this.dispatchEvent(new CustomEvent('layerpanelchange', {
      detail: { open: false }, bubbles: true, composed: true,
    }));
  }

  private _toggleLayers(): void {
    if (this._layersOpen) { this._closeLayers(); return; }
    this._layersOpen = true;
    this.dispatchEvent(new CustomEvent('layerpanelchange', {
      detail: { open: true }, bubbles: true, composed: true,
    }));
    void this.updateComplete.then(() => {
      if (this._layersOpen) this.renderRoot.querySelector<HTMLElement>('.layers-panel')?.focus({ preventScroll: true });
    });
  }

  private _renderProviderStatus(layer: RasterMapLayer) {
    const status = this._layerStatuses.find(item => item.id === layer.id);
    if (status?.error) return html`<div class="provider-status error" part="map-status" role="status" data-testid=${`map-layer-error-${layer.id}`}>
      <p>${status.error}</p><button part="map-button map-retry" type="button" @click=${() => this.retryMapLayer(layer.id)}>Retry ${layer.label}</button>
    </div>`;
    return status?.loading ? html`<p class="provider-status" part="map-status" role="status" data-testid=${`map-layer-loading-${layer.id}`}>Loading ${layer.label}…</p>` : nothing;
  }

  private _renderLayers() {
    const catalog = this._layerCatalog;
    const state = this._layerState;
    const hasLayers = Boolean(catalog && (catalog.basemaps.length || catalog.overlays?.length));
    if (!hasLayers && !this._layerConfigError) return nothing;
    const errors = this._layerStatuses.filter(status => status.error);
    return html`<div class="layer-controls" @pointerdown=${(event: Event) => event.stopPropagation()}
      @click=${(event: Event) => event.stopPropagation()} @dblclick=${(event: Event) => event.stopPropagation()}
      @wheel=${(event: Event) => event.stopPropagation()}
      @keydown=${(event: KeyboardEvent) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); this._closeLayers(); } }}>
      ${hasLayers ? html`<button part="map-button map-layer-toggle" type="button" class="layers-toggle" aria-label="Layers" aria-controls="map-layer-panel" aria-expanded=${this._layersOpen}
        @click=${this._toggleLayers}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m2 6 8-4 8 4-8 4-8-4Zm0 4 8 4 8-4M2 14l8 4 8-4"/></svg>
        Layers${errors.length ? html`<span class="layer-warning" aria-label="Some map layers failed">!</span>` : nothing}
      </button>` : nothing}
      ${this._layerConfigError ? html`<p class="layers-notice" part="map-status" role="alert">${this._layerConfigError}</p>` : nothing}
      ${!this._layersOpen && errors.length ? html`<p class="layers-notice" part="map-status" role="status">${errors.map(status => status.label).join(', ')} could not load. Open Layers to retry.</p>` : nothing}
      ${this._layersOpen && catalog && state ? html`<section id="map-layer-panel" class="layers-panel" part="map-layers-panel" aria-label="Map layers" tabindex="-1">
        <div class="layers-heading"><h3>Map layers</h3><button part="map-button" type="button" class="layers-close" aria-label="Close map layers" @click=${this._closeLayers}>×</button></div>
        ${catalog.basemaps.length ? html`<fieldset><legend>Basemap</legend>
          ${catalog.basemaps.map(layer => html`<label class="layer-choice" part="map-layer-option"><input type="radio" name="samplesift-basemap" .value=${layer.id}
            aria-label=${layer.label} .checked=${state.basemap === layer.id}
            @change=${() => this._changeMapLayers({ ...state, basemap: layer.id })}>
            <span><strong>${layer.label}</strong>${layer.description ? html`<small>${layer.description}</small>` : layer.year ? html`<small>${layer.year}</small>` : nothing}</span>
          </label>${state.basemap === layer.id ? this._renderProviderStatus(layer) : nothing}`)}
        </fieldset>` : nothing}
        ${(catalog.overlays ?? []).map(layer => {
          const preference = state.overlays[layer.id];
          return html`<div class="layer-overlays"><label class="layer-choice" part="map-layer-option"><input type="checkbox" aria-label=${layer.label}
            .checked=${preference.visible} @change=${(event: Event) => this._changeMapLayers({ ...state, overlays: { ...state.overlays, [layer.id]: { ...preference, visible: (event.target as HTMLInputElement).checked } } })}>
            <span><strong>${layer.label}${layer.year ? html` · ${layer.year}` : nothing}</strong>${layer.description ? html`<small>${layer.description}</small>` : nothing}</span>
          </label>
          ${preference.visible ? html`<label class="layer-opacity" part="map-opacity"><span>${layer.label} opacity <output>${Math.round(preference.opacity * 100)}%</output></span>
            <input type="range" min="0" max="100" step="5" aria-label=${`${layer.label} opacity`} .value=${String(Math.round(preference.opacity * 100))}
              @input=${(event: Event) => this._changeMapLayers({ ...state, overlays: { ...state.overlays, [layer.id]: { ...preference, opacity: Number((event.target as HTMLInputElement).value) / 100 } } })}>
          </label>${this._renderProviderStatus(layer)}` : nothing}
          ${layer.legend?.length ? html`<details class="layer-legend" part="map-legend"><summary>${layer.label} legend${layer.year ? ` · ${layer.year}` : ''}</summary><ul>
            ${layer.legend.map(item => html`<li><span class="layer-swatch" style=${`background-color: ${item.color}`} aria-hidden="true"></span>${item.label}</li>`)}
          </ul></details>` : nothing}
          </div>`;
        })}
      </section>` : nothing}
    </div>`;
  }

  protected render() {
    const selectionHint = this.selectionModes.length === 0
      ? 'Pan or zoom to explore matching features.'
      : `Draw a ${this.selectionModes.join(' or ')} to explore features in a region.`;
    const hint = this._error || (!this._ready ? 'Loading map…' : this._mode === 'rectangle'
      ? 'Click two opposite corners to select a rectangle.'
      : this._mode === 'polygon'
        ? 'Click to add corners. Click the first point to finish your polygon.'
        : this.selection ? 'Region selected. Draw a new region to replace it, or clear to search everywhere.'
          : selectionHint);
    const tileError = this.tileSource ? this._tileRequestError || this._tileRenderError : '';
    const tilesLoading = Boolean(this.tileSource && (this._tilePending > 0 || this._tilesRendering));
    return html`
      <div class="surface" part="map-surface">
        <div class="map" part="map" aria-busy=${tilesLoading}></div>
        <div class="toolbar" part="map-toolbar" role="group" aria-label="Map selection tools">
          <button part="map-button" type="button" aria-label="Pan map" aria-pressed=${this._mode === 'select'}
            ?disabled=${!this._ready} @click=${() => this.setMode('select')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3M15 7l3 3-3 3"/></svg>Pan
          </button>
          ${this.selectionModes.includes('rectangle') ? html`<button part="map-button" type="button" aria-pressed=${this._mode === 'rectangle'} ?disabled=${!this._ready}
            @click=${() => this.setMode('rectangle')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1"/></svg>Rectangle
          </button>` : nothing}
          ${this.selectionModes.includes('polygon') ? html`<button part="map-button" type="button" aria-pressed=${this._mode === 'polygon'} ?disabled=${!this._ready}
            @click=${() => this.setMode('polygon')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 11-1 3 10-8 5-8-7Z"/></svg>Polygon
          </button>` : nothing}
          <button part="map-button" type="button" class="clear" ?disabled=${!this._ready || (!this.selection && this._mode === 'select')}
            @click=${() => this.clearSelection()}>Clear</button>
        </div>
        ${this._renderLayers()}
        ${tileError ? html`<div class="hint tile-status error" part="map-status" role="alert" data-testid="tile-error">
          <div><strong>Map locations could not load.</strong><p>${tileError} Some locations may be missing.</p>
            <button part="map-button map-retry" type="button" class="retry" @click=${this.retryTiles}>Retry map tiles</button></div>
        </div>` : tilesLoading ? html`<div class="hint tile-status" part="map-status" role="status" aria-live="polite" data-testid="tile-loading">
          <span class="spinner" aria-hidden="true"></span><span>${this._hasLoadedTiles ? html`Updating map detail…<small>Cluster counts may still reflect the previous view.</small>` : 'Loading map locations…'}</span>
        </div>` : html`<div class="hint ${this._error ? 'error' : ''}" part="map-status" role="status" aria-live="polite">${hint}</div>`}
      </div>
    `;
  }
}

if (!customElements.get('sample-sift-map')) customElements.define('sample-sift-map', SampleSiftMap);

declare global {
  interface HTMLElementTagNameMap { 'sample-sift-map': SampleSiftMap }
}
