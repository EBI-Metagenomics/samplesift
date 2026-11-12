import type { Point, Polygon } from 'geojson';

export type FieldKind = 'number' | 'integer' | 'string' | 'date' | 'boolean';
export type Operator = '=' | '<>' | 'in' | 'isNull' | '>' | '>=' | '<' | '<=';
export type Scalar = string | number | boolean;
export type ScalarOperator = Exclude<Operator, 'in' | 'isNull'>;
export type Predicate =
  | { field: string; operator: 'isNull' }
  | { field: string; operator: 'in'; value: Scalar[] }
  | { field: string; operator: ScalarOperator; value: Scalar };

export interface QueryableField {
  name: string;
  kind: FieldKind;
  operators: Operator[];
  nullable: boolean;
  title?: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface CollectionMetadata {
  fields: QueryableField[];
  geometryField?: string;
  sortValues: string[];
  defaultLimit: number;
  maxLimit: number;
  resultColumns: Array<{ name: string; title: string }>;
  queryablesSchema: Record<string, unknown>;
  diagnostics: string[];
}

export interface CollectionSearchState {
  predicates: Predicate[];
  sort: string[];
  selection: Polygon | null;
}

export const EMPTY_COLLECTION_STATE: Readonly<CollectionSearchState> = Object.freeze({
  predicates: Object.freeze([]) as unknown as Predicate[],
  sort: Object.freeze([]) as unknown as string[],
  selection: null,
});
export function createEmptyCollectionState(): CollectionSearchState {
  return { predicates: [], sort: [], selection: null };
}

export interface SpatialMapping { longitudeField: string; latitudeField: string }
export interface CollectionOptions {
  /** API root, e.g. /samplesift or https://api.example/samplesift. */
  baseUrl: string;
  collection: string;
  tiles?: { sourceLayer: string; minZoom?: number; maxZoom?: number };
  spatial?: SpatialMapping;
}

export interface CqlExpression { op: string; args: unknown[] }
export interface CollectionQuery {
  filter?: CqlExpression;
  sort?: string[];
  limit?: number;
  offset?: number;
  cursor?: string;
}
export interface CollectionItem extends Record<string, unknown> {
  source_pk: string;
  geometry: Point | null;
}
export interface CollectionResult extends Record<string, unknown> {
  items: CollectionItem[];
  total?: number;
  limit: number;
  offset: number;
  nextCursor?: string;
}
export interface CollectionDataSource {
  metadata(options: { signal: AbortSignal }): Promise<CollectionMetadata>;
  search(query: CollectionQuery, options: { signal: AbortSignal }): Promise<CollectionResult>;
  tileUrlTemplate: string;
}
