import type { Polygon } from 'geojson';
import { validatePolygon } from '../data/validation';
import { isRecord, SUPPORTED_OPERATORS, validateFieldValue } from './schema';
import type { CollectionMetadata, CollectionQuery, CollectionSearchState, CqlExpression, Predicate, QueryableField, Scalar, SpatialMapping } from './types';

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}.`);
}
function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
function validatePredicateShape(value: unknown): asserts value is Predicate {
  if (!isRecord(value) || typeof value.field !== 'string' || !value.field
    || !SUPPORTED_OPERATORS.includes(value.operator as never)) throw new Error('Predicate requires a known operator and a field name.');
  onlyKeys(value, value.operator === 'isNull' ? ['field', 'operator'] : ['field', 'operator', 'value'], 'predicate');
  if (value.operator === 'isNull') return;
  if (value.operator === 'in') {
    if (!Array.isArray(value.value) || !value.value.length || !value.value.every(isScalar)) throw new Error('An in predicate requires a nonempty list of scalar values.');
  } else if (!isScalar(value.value)) throw new Error('Comparison predicates require a finite number, string or boolean value.');
}

/** Structural validation for state serialization before metadata is available. */
export function validateCollectionStateShape(state: unknown): asserts state is CollectionSearchState {
  if (!isRecord(state)) throw new Error('Collection search state must be an object.');
  onlyKeys(state, ['predicates', 'sort', 'selection'], 'collection state');
  if (!Array.isArray(state.predicates) || !Array.isArray(state.sort)
    || !state.sort.every(value => typeof value === 'string' && value.length > 0)) throw new Error('Collection state requires predicate and sort arrays.');
  for (const predicate of state.predicates) validatePredicateShape(predicate);
  if (state.selection !== null) validatePolygon(state.selection);
}

function fieldFor(metadata: CollectionMetadata, name: string): QueryableField {
  const field = metadata.fields.find(field => field.name === name);
  if (!field) throw new Error(`Unknown or unsupported queryable field: ${name}.`);
  return field;
}
function validatePredicate(predicate: Predicate, metadata: CollectionMetadata): void {
  const field = fieldFor(metadata, predicate.field);
  if (!field.operators.includes(predicate.operator)) throw new Error(`Operator ${predicate.operator} is not advertised for ${predicate.field}.`);
  if (predicate.operator === 'isNull') return;
  if (predicate.operator === 'in') {
    for (const value of predicate.value) validateFieldValue(field, value);
  } else validateFieldValue(field, predicate.value);
}
function validateSort(sort: string[], metadata: CollectionMetadata) {
  const fields = new Set<string>();
  for (const value of sort) {
    if (!metadata.sortValues.includes(value)) throw new Error(`Unsupported collection sort: ${value}.`);
    const field = value.startsWith('-') ? value.slice(1) : value;
    if (fields.has(field)) throw new Error(`Duplicate or conflicting sort for ${field}.`);
    fields.add(field);
  }
}
function rectanglePredicates(selection: Polygon, metadata: CollectionMetadata, spatial?: SpatialMapping): Predicate[] {
  if (!spatial || typeof spatial.longitudeField !== 'string' || typeof spatial.latitudeField !== 'string'
    || spatial.longitudeField === spatial.latitudeField) throw new Error('Spatial filtering requires an advertised geometry queryable or explicit longitude/latitude field mapping.');
  const ring = selection.coordinates[0];
  if (ring.length !== 5) throw new Error('This collection supports only an axis-aligned rectangle through its longitude/latitude mapping.');
  const xs = [...new Set(ring.slice(0, -1).map(position => position[0]))];
  const ys = [...new Set(ring.slice(0, -1).map(position => position[1]))];
  if (xs.length !== 2 || ys.length !== 2 || ring.slice(0, -1).some((point, index) => point[0] !== ring[index + 1][0] && point[1] !== ring[index + 1][1])) {
    throw new Error('This collection supports only an axis-aligned rectangle through its longitude/latitude mapping.');
  }
  for (const name of [spatial.longitudeField, spatial.latitudeField]) {
    const field = fieldFor(metadata, name);
    if (field.kind !== 'number' && field.kind !== 'integer') throw new Error(`Spatial coordinate field ${name} must be numeric.`);
    if (!field.operators.includes('>=') || !field.operators.includes('<=')) throw new Error(`Spatial coordinate field ${name} must advertise >= and <=.`);
  }
  return [
    { field: spatial.longitudeField, operator: '>=', value: Math.min(...xs) },
    { field: spatial.longitudeField, operator: '<=', value: Math.max(...xs) },
    { field: spatial.latitudeField, operator: '>=', value: Math.min(...ys) },
    { field: spatial.latitudeField, operator: '<=', value: Math.max(...ys) },
  ];
}

export function validateCollectionState(
  state: unknown,
  metadata: CollectionMetadata,
  spatial?: SpatialMapping,
): asserts state is CollectionSearchState {
  validateCollectionStateShape(state);
  for (const predicate of state.predicates) validatePredicate(predicate, metadata);
  validateSort(state.sort, metadata);
  if (state.selection && !metadata.geometryField) {
    for (const predicate of rectanglePredicates(state.selection, metadata, spatial)) validatePredicate(predicate, metadata);
  }
}
function literal(field: QueryableField, value: Scalar): unknown {
  return field.kind === 'date' ? { date: value } : field.kind === 'date-time' ? { timestamp: value } : value;
}
function compilePredicate(predicate: Predicate, metadata: CollectionMetadata): CqlExpression {
  const property = { property: predicate.field };
  if (predicate.operator === 'isNull') return { op: 'isNull', args: [property] };
  const field = fieldFor(metadata, predicate.field);
  if (predicate.operator === 'in') return { op: 'in', args: [property, predicate.value.map(value => literal(field, value))] };
  return { op: predicate.operator, args: [property, literal(field, predicate.value)] };
}

export function compileCollectionFilter(
  state: CollectionSearchState,
  metadata: CollectionMetadata,
  spatial?: SpatialMapping,
): CqlExpression | undefined {
  validateCollectionState(state, metadata, spatial);
  const expressions = state.predicates.map(predicate => compilePredicate(predicate, metadata));
  if (state.selection) {
    if (metadata.geometryField) {
      expressions.push({ op: 's_intersects', args: [{ property: metadata.geometryField }, structuredClone(state.selection)] });
    } else {
      expressions.push(...rectanglePredicates(state.selection, metadata, spatial).map(predicate => compilePredicate(predicate, metadata)));
    }
  }
  return expressions.length > 1 ? { op: 'and', args: expressions } : expressions[0];
}

function validatePagination(limit: unknown, offset: unknown, metadata: CollectionMetadata): void {
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > metadata.maxLimit) throw new Error(`Collection limit must be an integer from 1 to ${metadata.maxLimit}.`);
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Collection offset must be a nonnegative integer.');
}
export function buildCollectionQuery(
  state: CollectionSearchState,
  metadata: CollectionMetadata,
  page: { limit: number; offset: number },
  spatial?: SpatialMapping,
): CollectionQuery {
  const filter = compileCollectionFilter(state, metadata, spatial);
  validatePagination(page.limit, page.offset, metadata);
  return { ...(filter ? { filter } : {}), ...(state.sort.length ? { sort: [...state.sort] } : {}), limit: page.limit, offset: page.offset };
}

function propertyName(value: unknown): string {
  if (!isRecord(value) || typeof value.property !== 'string' || !value.property || Object.keys(value).length !== 1) throw new Error('CQL2 predicates require a single property reference.');
  return value.property;
}
function decodeLiteral(value: unknown, field: QueryableField): Scalar {
  if (field.kind === 'date' || field.kind === 'date-time') {
    const key = field.kind === 'date' ? 'date' : 'timestamp';
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value[key] !== 'string') throw new Error(`${field.name} requires a CQL2 ${key} literal.`);
    validateFieldValue(field, value[key]);
    return value[key];
  }
  validateFieldValue(field, value);
  return value;
}
function validateExpression(value: unknown, metadata: CollectionMetadata, depth = 0): void {
  if (depth > 32 || !isRecord(value) || typeof value.op !== 'string' || !Array.isArray(value.args)) throw new Error('Invalid or excessively nested CQL2 expression.');
  onlyKeys(value, ['op', 'args'], 'CQL2 expression');
  if (value.op === 'and') {
    if (!value.args.length) throw new Error('CQL2 and requires at least one expression.');
    for (const expression of value.args) validateExpression(expression, metadata, depth + 1);
    return;
  }
  if (value.op === 's_intersects') {
    if (value.args.length !== 2 || !metadata.geometryField || propertyName(value.args[0]) !== metadata.geometryField) throw new Error('s_intersects requires this collection’s advertised geometry queryable.');
    validatePolygon(value.args[1]);
    return;
  }
  if (!SUPPORTED_OPERATORS.includes(value.op as never)) throw new Error(`Unsupported CQL2 operator: ${value.op}.`);
  const field = fieldFor(metadata, propertyName(value.args[0]));
  if (!field.operators.includes(value.op as never)) throw new Error(`Operator ${value.op} is not advertised for ${field.name}.`);
  if (value.op === 'isNull') {
    if (value.args.length !== 1) throw new Error('CQL2 isNull requires one property argument.');
    return;
  }
  if (value.args.length !== 2) throw new Error(`CQL2 ${value.op} requires two arguments.`);
  if (value.op === 'in') {
    if (!Array.isArray(value.args[1]) || !value.args[1].length) throw new Error('CQL2 in requires a nonempty value list.');
    for (const item of value.args[1]) decodeLiteral(item, field);
  } else decodeLiteral(value.args[1], field);
}

/** Validate exposed raw QUERY requests too; no unsupported CQL2 predicate is silently forwarded. */
export function validateCollectionQuery(query: unknown, metadata: CollectionMetadata): asserts query is CollectionQuery {
  if (!isRecord(query)) throw new Error('Collection query must be an object.');
  onlyKeys(query, ['filter', 'sort', 'limit', 'offset', 'cursor'], 'collection query');
  if (query.filter !== undefined) validateExpression(query.filter, metadata);
  if (query.sort !== undefined) {
    if (!Array.isArray(query.sort) || !query.sort.every(value => typeof value === 'string')) throw new Error('Collection sort must be an array of strings.');
    validateSort(query.sort, metadata);
  }
  validatePagination(query.limit === undefined ? metadata.defaultLimit : query.limit, query.offset === undefined ? 0 : query.offset, metadata);
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor)) throw new Error('Collection cursor must be a nonempty string.');
}
