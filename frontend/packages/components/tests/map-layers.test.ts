import { describe, expect, it } from 'vitest';
import { defaultMapLayers, normalizeMapLayerState, validateMapLayerCatalog } from '../src/map/layers';
import type { MapLayerCatalog, MapLayerState } from '../src/map/layers';

const catalog = (): MapLayerCatalog => ({
  basemaps: [{ id: 'standard', label: 'Standard', tiles: ['http://127.0.0.1:5173/tiles/{z}/{x}/{y}.png'], attribution: 'Example maps' }],
  overlays: [{ id: 'cover', label: 'Cover', tiles: ['/tiles/cover/{z}/{x}/{y}.png'], attribution: 'Example land cover', year: 2021, resampling: 'nearest' }],
});

describe('map layer catalog', () => {
  it('contains the three public basemaps and an attributed 11-class 2021 overlay', () => {
    expect(() => validateMapLayerCatalog(defaultMapLayers)).not.toThrow();
    expect(defaultMapLayers.basemaps.map(layer => layer.id)).toEqual(['standard', 'satellite', 'topographic']);
    expect(defaultMapLayers.basemaps.find(layer => layer.id === 'satellite')).toMatchObject({ year: 2021, minZoom: 0, maxZoom: 19 });
    const overlay = defaultMapLayers.overlays?.[0];
    expect(overlay).toMatchObject({ id: 'worldcover-2021', year: 2021, minZoom: 0, maxZoom: 19, resampling: 'nearest' });
    expect(overlay?.legend).toHaveLength(11);
    expect(new Set(overlay?.legend?.map(entry => entry.color)).size).toBe(11);
    expect(overlay?.attribution).toContain('Contains modified Copernicus Sentinel data (2021)');
  });

  it('accepts local fixtures, root-relative XYZ URLs and standard WMS templates', () => {
    const configuration = catalog();
    expect(() => validateMapLayerCatalog(configuration)).not.toThrow();
    configuration.basemaps[0].tiles = ['https://example.org/wms?bbox={bbox-epsg-3857}&width=256&height=256'];
    expect(() => validateMapLayerCatalog(configuration)).not.toThrow();
  });

  it('rejects ambiguous IDs and malformed provider configuration', () => {
    const duplicate = catalog();
    duplicate.overlays = [{ ...duplicate.basemaps[0] }];
    expect(() => validateMapLayerCatalog(duplicate)).toThrow(/Duplicate/);
    for (const patch of [
      { tiles: ['javascript:alert(1)'] }, { tiles: ['https://example.org/plain.png'] },
      { attribution: '' }, { tileSize: 128 }, { minZoom: 9, maxZoom: 8 },
      { minZoom: -1 }, { maxZoom: 25 }, { resampling: 'cubic' },
      { legend: [{ label: 'Forest', color: 'url(example)' }] },
    ]) {
      const configuration = catalog();
      Object.assign(configuration.basemaps[0], patch);
      expect(() => validateMapLayerCatalog(configuration)).toThrow();
    }
  });
});

describe('map layer state normalization', () => {
  it('starts with the first basemap, hidden overlays, and independent state snapshots', () => {
    const configuration = catalog();
    const first = normalizeMapLayerState(undefined, configuration);
    const second = normalizeMapLayerState(undefined, configuration);
    expect(first).toEqual({ basemap: 'standard', overlays: { cover: { visible: false, opacity: 0.45 } } });
    first.overlays.cover.visible = true;
    expect(second.overlays.cover.visible).toBe(false);
    expect(normalizeMapLayerState(undefined, { basemaps: [] })).toEqual({ basemap: '', overlays: {} });
  });

  it('normalizes supplied overlay state without mutating the caller or dropping defaults', () => {
    const configuration = catalog();
    const supplied: MapLayerState = { basemap: 'standard', overlays: { cover: { visible: true, opacity: 0.7 } } };
    const normalized = normalizeMapLayerState(supplied, configuration);
    expect(normalized).toEqual(supplied);
    normalized.overlays.cover.opacity = 0.2;
    expect(supplied.overlays.cover.opacity).toBe(0.7);
    expect(normalizeMapLayerState({ basemap: 'standard', overlays: {} }, configuration).overlays.cover)
      .toEqual({ visible: false, opacity: 0.45 });
  });

  it('rejects unknown selections and invalid visibility or opacity instead of silently replacing them', () => {
    for (const state of [
      { basemap: 'unknown', overlays: {} }, { basemap: 'standard' },
      { basemap: 'standard', overlays: { unknown: { visible: true, opacity: 0.5 } } },
      ...[NaN, Infinity, -0.1, 1.1].map(opacity => ({ basemap: 'standard', overlays: { cover: { visible: true, opacity } } })),
      { basemap: 'standard', overlays: { cover: { visible: 'yes', opacity: 0.5 } } },
    ]) expect(() => normalizeMapLayerState(state, catalog())).toThrow();
  });
});
