/** Raster providers are independent from collection queries and selection state. */
export interface RasterMapLayer {
  id: string;
  label: string;
  tiles: string[];
  attribution: string;
  tileSize?: 256 | 512;
  minZoom?: number;
  maxZoom?: number;
  description?: string;
  year?: number;
  legend?: { label: string; color: string }[];
  resampling?: 'nearest' | 'linear';
}
export interface MapLayerCatalog {
  basemaps: readonly RasterMapLayer[];
  overlays?: readonly RasterMapLayer[];
}
export interface MapLayerState {
  basemap: string;
  overlays: Record<string, { visible: boolean; opacity: number }>;
}

const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const worldcoverAttribution = '&copy; <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover project 2021</a> / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium';
const worldcoverTile = (layer: string) => `https://mapproxy.terrascope.be/mapproxy/wmts/${layer}/webmercator/{z}/{x}/{y}.png`;

// Cached WMTS used by the official ESA viewer; its global matrix set spans z0–19.
// https://mapproxy.terrascope.be/mapproxy/wmts/1.0.0/WMTSCapabilities.xml
// Product/attribution: https://esa-worldcover.org/en/data-access
export const defaultMapLayers: MapLayerCatalog = {
  basemaps: [
    {
      id: 'standard', label: 'Standard', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: osmAttribution, tileSize: 256, minZoom: 0, maxZoom: 19,
      description: 'OpenStreetMap streets and places.',
    },
    {
      id: 'satellite', label: 'Satellite',
      tiles: [worldcoverTile('esa-worldcover-s2rgbnir-10m-2021-v2_tcc')],
      attribution: worldcoverAttribution, tileSize: 256, minZoom: 0, maxZoom: 19, year: 2021,
      description: 'Sentinel-2 annual RGB composite, 2021 (10 m product).',
      resampling: 'linear',
    },
    {
      id: 'topographic', label: 'Topographic', tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
      attribution: `${osmAttribution}, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</a>)`,
      tileSize: 256, minZoom: 0, maxZoom: 17, description: 'OpenTopoMap terrain, contours, and places.',
    },
  ],
  overlays: [{
    id: 'worldcover-2021', label: 'WorldCover',
    tiles: [worldcoverTile('esa-worldcover-map-10m-2021-v2_map')],
    attribution: worldcoverAttribution, tileSize: 256, minZoom: 0, maxZoom: 19, year: 2021,
    description: 'ESA land-cover classes, 2021 (10 m product).',
    resampling: 'nearest',
    legend: [
      { label: 'Tree cover', color: '#006400' },
      { label: 'Shrubland', color: '#ffbb22' },
      { label: 'Grassland', color: '#ffff4c' },
      { label: 'Cropland', color: '#f096ff' },
      { label: 'Built-up', color: '#fa0000' },
      { label: 'Bare / sparse vegetation', color: '#b4b4b4' },
      { label: 'Snow and ice', color: '#f0f0f0' },
      { label: 'Permanent water bodies', color: '#0064c8' },
      { label: 'Herbaceous wetland', color: '#0096a0' },
      { label: 'Mangroves', color: '#00cf75' },
      { label: 'Moss and lichen', color: '#fae6a0' },
    ],
  }],
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} contains an unsupported property.`);
}

/** Validate configuration without touching the DOM, network, or host state. */
export function validateMapLayerCatalog(value: unknown): asserts value is MapLayerCatalog {
  if (!record(value) || !Array.isArray(value.basemaps) || (value.overlays !== undefined && !Array.isArray(value.overlays))) {
    throw new Error('Map layers require a basemaps array and an optional overlays array.');
  }
  onlyKeys(value, ['basemaps', 'overlays'], 'Map layer catalog');
  const ids = new Set<string>();
  for (const layer of [...value.basemaps, ...(value.overlays ?? [])]) {
    if (!record(layer) || !text(layer.id) || !/^[a-z0-9][a-z0-9._-]*$/i.test(layer.id)
      || !text(layer.label) || !text(layer.attribution)) throw new Error('Map layers require an ID, label, and attribution.');
    onlyKeys(layer, ['id', 'label', 'tiles', 'attribution', 'tileSize', 'minZoom', 'maxZoom', 'description', 'year', 'legend', 'resampling'], 'Map layer');
    if (ids.has(layer.id)) throw new Error(`Duplicate map layer ID: ${layer.id}.`);
    ids.add(layer.id);
    if (!Array.isArray(layer.tiles) || !layer.tiles.length || !layer.tiles.every(url => {
      if (!text(url) || !(/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url))) return false;
      if (!(['{z}', '{x}', '{y}'].every(token => url.includes(token)) || url.includes('{bbox-epsg-3857}'))) return false;
      try { const parsed = new URL(url, 'http://localhost'); return !parsed.username && !parsed.password; } catch { return false; }
    })) throw new Error(`Map layer ${layer.id} requires HTTP(S) XYZ or Web Mercator BBOX tile URLs.`);
    if (layer.tileSize !== undefined && layer.tileSize !== 256 && layer.tileSize !== 512) throw new Error('Raster tile size must be 256 or 512.');
    const min = layer.minZoom ?? 0;
    const max = layer.maxZoom ?? 22;
    if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 0 || (max as number) > 24 || (min as number) > (max as number)) throw new Error('Raster zoom bounds must be ordered integers from 0 to 24.');
    if (layer.description !== undefined && !text(layer.description)) throw new Error('Map layer descriptions must be nonempty text.');
    if (layer.year !== undefined && (!Number.isInteger(layer.year) || (layer.year as number) < 1 || (layer.year as number) > 9999)) throw new Error('Map layer year must be a valid year.');
    if (layer.resampling !== undefined && !['nearest', 'linear'].includes(layer.resampling as string)) throw new Error('Raster resampling must be nearest or linear.');
    if (layer.legend !== undefined && (!Array.isArray(layer.legend) || !layer.legend.every(entry => record(entry)
      && text(entry.label) && typeof entry.color === 'string' && /^#[\da-f]{6}$/i.test(entry.color)))) throw new Error('Map legends require labels and six-digit hex colors.');
  }
}

/** Return a fresh, complete UI state; omitted overlays start hidden at 45% opacity. */
export function normalizeMapLayerState(state: unknown | undefined, catalog: MapLayerCatalog): MapLayerState {
  validateMapLayerCatalog(catalog);
  const defaults = Object.fromEntries((catalog.overlays ?? []).map(layer => [layer.id, { visible: false, opacity: 0.45 }]));
  if (state === undefined) return { basemap: catalog.basemaps[0]?.id ?? '', overlays: defaults };
  if (!record(state) || typeof state.basemap !== 'string' || !record(state.overlays)) throw new Error('Map layer state requires basemap and overlays.');
  onlyKeys(state, ['basemap', 'overlays'], 'Map layer state');
  if (!(catalog.basemaps.some(layer => layer.id === state.basemap) || (!catalog.basemaps.length && state.basemap === ''))) throw new Error('The selected basemap is not in the map layer catalog.');
  for (const [id, setting] of Object.entries(state.overlays)) {
    if (!Object.hasOwn(defaults, id)) throw new Error(`Unknown map overlay: ${id}.`);
    if (!record(setting) || typeof setting.visible !== 'boolean' || typeof setting.opacity !== 'number'
      || !Number.isFinite(setting.opacity) || setting.opacity < 0 || setting.opacity > 1) throw new Error('Overlay state requires visible and opacity from 0 to 1.');
    onlyKeys(setting, ['visible', 'opacity'], 'Overlay state');
    defaults[id] = { visible: setting.visible, opacity: setting.opacity };
  }
  return { basemap: state.basemap, overlays: defaults };
}
