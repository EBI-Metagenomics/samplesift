import type { ErrorEvent, Map as MapLibreMap } from 'maplibre-gl';
import type { MapLayerCatalog, MapLayerState, RasterMapLayer } from './layers';

export interface ManagedLayerStatus { id: string; label: string; loading: boolean; error: string }
interface ActiveLayer {
  definition: RasterMapLayer;
  sourceId: string;
  layerId: string;
  opacity: number;
  status: ManagedLayerStatus;
  timeout?: ReturnType<typeof setTimeout>;
}
let managerSequence = 0;
export const MANAGED_SOURCE_PREFIX = 'samplesift-context-';

/** Owns only contextual rasters; sample sources and Terra Draw never enter this lifecycle. */
export class ManagedRasterLayers {
  private readonly prefix = `${MANAGED_SOURCE_PREFIX}${++managerSequence}-`;
  private revision = 0;
  private active = new Map<string, ActiveLayer>();
  private sourceIds = new Map<string, string>();
  private destroyed = false;

  constructor(
    private readonly map: MapLibreMap,
    private readonly onStatus: (statuses: ManagedLayerStatus[]) => void,
    private readonly onError: (id: string, message: string) => void,
    private readonly beforeLayerId = 'samplesift-selection-fill',
  ) {
    map.on('sourcedataloading', this.loading);
    map.on('sourcedata', this.loaded);
    map.on('sourcedataabort', this.loaded);
    map.on('error', this.failed);
  }

  update(catalog: MapLayerCatalog | undefined, state: MapLayerState | undefined) {
    if (this.destroyed) return;
    const wanted = new Map<string, { definition: RasterMapLayer; opacity: number }>();
    if (catalog && state) {
      const base = catalog.basemaps.find(layer => layer.id === state.basemap);
      if (base) wanted.set(base.id, { definition: base, opacity: 1 });
      for (const layer of catalog.overlays ?? []) {
        const preference = state.overlays[layer.id];
        if (preference?.visible) wanted.set(layer.id, { definition: layer, opacity: preference.opacity });
      }
    }
    for (const [id, active] of this.active) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next.definition) !== JSON.stringify(active.definition)) this.remove(id);
    }
    for (const [id, { definition, opacity }] of wanted) {
      const active = this.active.get(id);
      if (!active) this.add(definition, opacity);
      else if (active.opacity !== opacity) {
        active.opacity = opacity;
        this.map.setPaintProperty(active.layerId, 'raster-opacity', opacity);
      }
    }
    // Catalog order is basemap then overlays. Move only our layers, below region/data/drawing.
    for (const id of wanted.keys()) {
      const active = this.active.get(id);
      if (active && this.map.getLayer(active.layerId)) this.map.moveLayer(active.layerId, this.beforeLayerId);
    }
    this.notify();
  }

  retry(id: string) {
    const active = this.active.get(id);
    if (!active || this.destroyed) return;
    const { definition, opacity } = active;
    this.remove(id);
    this.add(definition, opacity);
    // The component immediately reapplies catalog order after recreating this provider.
    this.notify();
  }

  destroy() {
    this.destroyed = true;
    this.map.off('sourcedataloading', this.loading);
    this.map.off('sourcedata', this.loaded);
    this.map.off('sourcedataabort', this.loaded);
    this.map.off('error', this.failed);
    for (const active of this.active.values()) clearTimeout(active.timeout);
    this.active.clear();
    this.sourceIds.clear();
  }

  private add(definition: RasterMapLayer, opacity: number) {
    const sourceId = `${this.prefix}${++this.revision}`;
    const active: ActiveLayer = {
      definition: structuredClone(definition), sourceId, layerId: `${sourceId}-raster`, opacity,
      status: { id: definition.id, label: definition.label, loading: true, error: '' },
    };
    this.active.set(definition.id, active);
    this.sourceIds.set(sourceId, definition.id);
    this.armTimeout(active);
    try {
      this.map.addSource(sourceId, {
        type: 'raster', tiles: [...definition.tiles], tileSize: definition.tileSize ?? 256,
        minzoom: definition.minZoom ?? 0, maxzoom: definition.maxZoom ?? 22,
        attribution: definition.attribution,
      });
      this.map.addLayer({
        id: active.layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': opacity, 'raster-resampling': definition.resampling ?? 'linear', 'raster-fade-duration': 0 },
      }, this.beforeLayerId);
    } catch {
      this.setError(active, `${definition.label} could not load. Retry this layer or choose another.`);
    }
  }

  private remove(id: string) {
    const active = this.active.get(id);
    if (!active) return;
    clearTimeout(active.timeout);
    this.sourceIds.delete(active.sourceId);
    this.active.delete(id);
    if (this.map.getLayer(active.layerId)) this.map.removeLayer(active.layerId);
    if (this.map.getSource(active.sourceId)) this.map.removeSource(active.sourceId);
  }

  private find(sourceId?: string) {
    const id = sourceId ? this.sourceIds.get(sourceId) : undefined;
    return id ? this.active.get(id) : undefined;
  }

  private loading = (event: { sourceId: string }) => {
    const active = this.find(event.sourceId);
    if (!active || active.status.error) return;
    if (!active.status.loading) this.armTimeout(active);
    active.status.loading = true;
    this.notify();
  };

  private loaded = (event: { sourceId: string }) => {
    const active = this.find(event.sourceId);
    if (!active || !this.map.getSource(event.sourceId)) return;
    active.status.loading = !this.map.isSourceLoaded(event.sourceId);
    if (!active.status.loading) clearTimeout(active.timeout);
    this.notify();
  };

  private failed = (event: ErrorEvent) => {
    const active = this.find((event as unknown as { sourceId?: string }).sourceId);
    if (!active || (event.error as { name?: string })?.name === 'AbortError') return;
    this.setError(active, `${active.definition.label} could not load. Retry this layer or choose another.`);
  };

  private armTimeout(active: ActiveLayer) {
    clearTimeout(active.timeout);
    active.timeout = setTimeout(() => {
      if (this.active.get(active.definition.id) !== active || !active.status.loading) return;
      this.setError(active, `${active.definition.label} is taking too long to load. Retry this layer or choose another.`);
    }, 15_000);
  }

  private setError(active: ActiveLayer, message: string) {
    const changed = active.status.error !== message;
    clearTimeout(active.timeout);
    active.status = { ...active.status, loading: false, error: message };
    this.notify();
    if (changed) this.onError(active.definition.id, message);
  }

  private notify() { if (!this.destroyed) this.onStatus([...this.active.values()].map(active => ({ ...active.status }))); }
}
