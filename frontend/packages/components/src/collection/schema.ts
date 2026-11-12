import type { CollectionMetadata, FieldKind, Operator, QueryableField, Scalar } from './types';

export const SUPPORTED_OPERATORS: readonly Operator[] = ['=', '<>', 'in', 'isNull', '>', '>=', '<', '<='];
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'example', 'readOnly', 'writeOnly', 'deprecated']);
const KEYWORDS = new Set(['type', 'format', 'nullable', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']);
const NUMERIC_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const STRING_KEYS = ['minLength', 'maxLength', 'pattern'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validScalarType(value: unknown, kind: FieldKind): value is Scalar {
  if (kind === 'number' || kind === 'integer') return typeof value === 'number' && Number.isFinite(value) && (kind !== 'integer' || Number.isSafeInteger(value));
  if (kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && (kind !== 'date' || isCalendarDate(value));
}

/** Enforce every supported declared constraint; unknown constraints make the field unavailable. */
export function validateFieldValue(field: QueryableField, value: unknown): asserts value is Scalar {
  if (!validScalarType(value, field.kind)) throw new Error(`${field.name} requires a valid ${field.kind} value.`);
  const schema = field.schema ?? {};
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) throw new Error(`${field.name} must be one of its declared enum values.`);
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) throw new Error(`${field.name} must equal its declared constant.`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${field.name} is below its minimum.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${field.name} is above its maximum.`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) throw new Error(`${field.name} must exceed its exclusive minimum.`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) throw new Error(`${field.name} must be below its exclusive maximum.`);
    if (typeof schema.multipleOf === 'number') {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Math.min(1e-8, Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8)) throw new Error(`${field.name} must be a multiple of ${schema.multipleOf}.`);
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) throw new Error(`${field.name} is shorter than its minimum length.`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) throw new Error(`${field.name} exceeds its maximum length.`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${field.name} does not match its declared pattern.`);
  }
}

function fieldKind(schema: Record<string, unknown>): { kind: FieldKind; nullable: boolean } {
  let types: unknown[] = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (!types.length && Array.isArray(schema.enum)) {
    types = [...new Set(schema.enum.map(value => value === null ? 'null' : typeof value))];
  }
  if (new Set(types).size !== types.length) throw new Error('duplicate types are invalid');
  const nullable = types.includes('null') || schema.nullable === true;
  const nonNull = types.filter(type => type !== 'null');
  if (nonNull.length !== 1 || !['number', 'integer', 'string', 'boolean'].includes(String(nonNull[0]))) throw new Error('only one primitive type, optionally nullable, is supported');
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') throw new Error('nullable must be boolean');
  let kind = nonNull[0] as FieldKind;
  if (schema.format !== undefined) {
    if (schema.format === 'date' && kind === 'string') kind = 'date';
    else throw new Error(`unsupported format ${String(schema.format)}`);
  }
  return { kind, nullable };
}

function parseField(name: string, input: unknown, diagnostics: string[]): QueryableField {
  if (!isRecord(input)) throw new Error('field schema must be an object');
  const schema = structuredClone(input);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key) && !key.startsWith('x-')) throw new Error(`unsupported schema constraint ${key}`);
  }
  const { kind, nullable } = fieldKind(schema);
  const numeric = kind === 'number' || kind === 'integer';
  for (const key of NUMERIC_KEYS) {
    if (schema[key] === undefined) continue;
    if (!numeric || typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || (key === 'multipleOf' && schema[key] <= 0)) throw new Error(`invalid ${key} constraint`);
  }
  for (const key of STRING_KEYS) {
    if (schema[key] === undefined) continue;
    if (kind !== 'string' && kind !== 'date') throw new Error(`${key} requires a string field`);
    if (key === 'pattern') {
      if (typeof schema[key] !== 'string') throw new Error('pattern must be a string');
      try { new RegExp(schema[key], 'u'); } catch { throw new Error('pattern is not supported by this client'); }
    } else if (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0) throw new Error(`invalid ${key} constraint`);
  }
  if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) throw new Error('minimum exceeds maximum');
  if (typeof schema.minLength === 'number' && typeof schema.maxLength === 'number' && schema.minLength > schema.maxLength) throw new Error('minLength exceeds maxLength');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new Error('enum must be a nonempty array');
  const field: QueryableField = { name, kind, nullable, operators: [], schema };
  if (typeof schema.title === 'string') field.title = schema.title;
  if (typeof schema.description === 'string') field.description = schema.description;
  for (const candidate of Array.isArray(schema.enum) ? schema.enum : []) {
    if (candidate === null ? !nullable : !validScalarType(candidate, kind)) throw new Error('enum contains a value outside the declared type');
  }
  if (Object.hasOwn(schema, 'const') && (schema.const === null ? !nullable : !validScalarType(schema.const, kind))) throw new Error('const does not match the declared type');
  const extension = schema['x-samplesift'];
  if (!isRecord(extension) || !Array.isArray(extension.operators) || extension.operators.length === 0) throw new Error('no operator capability list was advertised');
  for (const operator of extension.operators) {
    if (typeof operator !== 'string' || !SUPPORTED_OPERATORS.includes(operator as Operator)) {
      diagnostics.push(`${name}: unsupported operator ${String(operator)} is unavailable.`);
      continue;
    }
    if (kind === 'boolean' && ['>', '>=', '<', '<='].includes(operator)) {
      diagnostics.push(`${name}: ordered boolean operator ${operator} is unavailable.`);
      continue;
    }
    if (!field.operators.includes(operator as Operator)) field.operators.push(operator as Operator);
  }
  if (!field.operators.length) throw new Error('no supported advertised operators remain');
  return field;
}

function resolve(value: unknown, document: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected an OpenAPI schema object.');
  let current = value;
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error('Only acyclic local OpenAPI references are supported.');
    seen.add(ref);
    let target: unknown = document;
    for (const part of ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      target = isRecord(target) ? target[part] : undefined;
    }
    if (!isRecord(target)) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
    const siblings = { ...current };
    delete siblings.$ref;
    current = { ...target, ...siblings };
  }
  return current;
}
function nested(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = isRecord(current) ? current[key] : undefined;
  return current;
}

/** Read queryables plus the exact collection QUERY operation's request/response models. */
export function parseCollectionMetadata(
  queryables: unknown,
  openapi: unknown,
  { collection }: { collection: string; baseUrl?: string },
): CollectionMetadata {
  if (!isRecord(queryables) || queryables.type !== 'object' || !isRecord(queryables.properties)) throw new Error('Queryables must describe an object with properties.');
  if (!isRecord(openapi) || !isRecord(openapi.paths)) throw new Error('OpenAPI metadata must contain paths.');
  if (typeof collection !== 'string' || !collection) throw new Error('Collection identifier is required.');
  const suffixes = [`/collections/${encodeURIComponent(collection)}/results`, `/collections/${collection}/results`];
  const matches = Object.entries(openapi.paths).filter(([path, item]) => suffixes.some(suffix => path.endsWith(suffix)) && isRecord(item) && isRecord(item.query));
  if (matches.length !== 1) throw new Error('Expected exactly one QUERY results operation for this collection.');
  const operation = (matches[0][1] as Record<string, unknown>).query as Record<string, unknown>;
  const request = resolve(nested(operation, 'requestBody', 'content', 'application/json', 'schema'), openapi);
  if (!isRecord(request.properties)) throw new Error('The collection request schema must describe its properties.');
  const sortSchema = resolve(request.properties.sort, openapi);
  const sortItems = resolve(sortSchema.items, openapi);
  if (sortSchema.type !== 'array' || !Array.isArray(sortItems.enum) || !sortItems.enum.every(value => typeof value === 'string' && value.length > 0)) throw new Error('Collection sort capabilities must be an explicit string enum.');
  const sortValues = [...new Set(sortItems.enum)] as string[];
  const limit = resolve(request.properties.limit, openapi);
  if (limit.type !== 'integer' || !Number.isSafeInteger(limit.maximum) || (limit.maximum as number) < 1
    || !Number.isSafeInteger(limit.default) || (limit.default as number) < 1 || (limit.default as number) > (limit.maximum as number)
    || (limit.minimum !== undefined && limit.minimum !== 1)) throw new Error('Collection pagination requires an integer limit with supported minimum, default and maximum.');
  const offset = resolve(request.properties.offset, openapi);
  if (offset.type !== 'integer' || (offset.minimum !== undefined && offset.minimum !== 0)) throw new Error('Collection pagination requires a nonnegative integer offset.');
  const response = resolve(nested(operation, 'responses', '200', 'content', 'application/json', 'schema'), openapi);
  const items = resolve(nested(response, 'properties', 'items'), openapi);
  const row = resolve(items.items, openapi);
  if (items.type !== 'array' || !isRecord(row.properties)) throw new Error('Collection response must describe its items and result columns.');
  const diagnostics: string[] = [];
  const fields: QueryableField[] = [];
  const geometryFields: string[] = [];
  for (const [name, fieldSchema] of Object.entries(queryables.properties)) {
    if (isRecord(fieldSchema) && fieldSchema.type === 'object'
      && isRecord(fieldSchema['x-samplesift']) && Array.isArray(fieldSchema['x-samplesift'].operators)
      && fieldSchema['x-samplesift'].operators.includes('s_intersects')) {
      geometryFields.push(name);
      for (const operator of fieldSchema['x-samplesift'].operators) {
        if (operator !== 's_intersects') diagnostics.push(`${name}: unsupported geometry operator ${String(operator)} is unavailable.`);
      }
      continue;
    }
    try { fields.push(parseField(name, fieldSchema, diagnostics)); } catch (error) {
      diagnostics.push(`${name}: ${error instanceof Error ? error.message : String(error)}; filtering this field is unavailable.`);
    }
  }
  if (geometryFields.length > 1) throw new Error('Multiple geometry queryables are ambiguous; exactly one is supported.');
  const resultColumns = Object.entries(row.properties).map(([name, schema]) => ({ name, title: isRecord(schema) && typeof schema.title === 'string' ? schema.title : name }));
  return {
    fields, ...(geometryFields[0] ? { geometryField: geometryFields[0] } : {}), sortValues, defaultLimit: limit.default as number, maxLimit: limit.maximum as number,
    resultColumns, queryablesSchema: structuredClone(queryables), diagnostics,
  };
}
