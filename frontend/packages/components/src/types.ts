import type { Polygon } from 'geojson';

export interface Sample {
  accession: string;
  title: string;
  longitude: number;
  latitude: number;
  biome: string;
  collectionDate: string | null;
  sourceUrl?: string;
}

export interface SampleFilters {
  biome: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface SearchQuery {
  selection: Polygon | null;
  filters: SampleFilters;
  offset: number;
  limit: number;
}

export interface SearchResult {
  items: Sample[];
  total: number;
  facets: { biomes: Array<{ value: string; count: number }> };
}

export interface SampleDataSource {
  search(query: SearchQuery, options: { signal: AbortSignal }): Promise<SearchResult>;
}

export const EMPTY_FILTERS: SampleFilters = { biome: null, dateFrom: null, dateTo: null };

export interface SelectionChangeDetail { geometry: Polygon | null }
export interface SampleClickDetail { accession: string; sample: Sample }
export interface ResultsChangeDetail { query: SearchQuery; result: SearchResult }
export interface SearchErrorDetail { message: string }
