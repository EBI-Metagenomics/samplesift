import type { Polygon } from 'geojson';

/** A taxon observed in the declared analysis profile for one assembly. */
export interface TaxonEvidence {
  id: string;
  label?: string;
  ancestorIds?: string[];
}

/** N50 and taxonomy predicates must match this same evidence record. */
export interface AssemblyEvidence {
  accession: string;
  contigN50Bp: number | null;
  taxa: TaxonEvidence[];
}

export interface Sample {
  accession: string;
  title: string;
  longitude: number;
  latitude: number;
  biome: string;
  collectionDate: string | null;
  sourceUrl?: string;
  assemblies?: AssemblyEvidence[];
}

export interface SampleFilters {
  biome: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  n50MinBp: number | null;
  n50MaxBp: number | null;
  taxonId: string | null;
  includeDescendants: boolean;
}

export type FilterField = 'n50' | 'taxonomy' | 'biome' | 'collectionDate';
export interface TaxonomyOption { id: string; label: string }
export interface SearchState { selection: Polygon | null; filters: SampleFilters }

export interface SearchQuery extends SearchState {
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

export const EMPTY_FILTERS: Readonly<SampleFilters> = Object.freeze({
  biome: null, dateFrom: null, dateTo: null,
  n50MinBp: null, n50MaxBp: null, taxonId: null, includeDescendants: false,
});

export interface FiltersChangeDetail { filters: SampleFilters }
export interface SelectionChangeDetail { geometry: Polygon | null }
export interface SampleClickDetail { accession: string; sample: Sample }
export interface ResultsChangeDetail { query: SearchQuery; result: SearchResult }
export interface SearchErrorDetail { message: string }
