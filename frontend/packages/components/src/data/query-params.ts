import type { SampleFilters } from '../types';
import { normalizeFilters, validateFilters } from './filters';

export type FilterParameterNames = Partial<Record<keyof SampleFilters, string>>;

const FILTER_FIELDS = [
  'biome', 'dateFrom', 'dateTo', 'n50MinBp', 'n50MaxBp', 'taxonId', 'includeDescendants',
] as const satisfies readonly (keyof SampleFilters)[];

const DEFAULT_PARAMETER_NAMES: Readonly<Record<keyof SampleFilters, string>> = {
  biome: 'biome',
  dateFrom: 'date_from',
  dateTo: 'date_to',
  n50MinBp: 'contig_n50_min',
  n50MaxBp: 'contig_n50_max',
  taxonId: 'taxon_id',
  includeDescendants: 'include_descendants',
};

const RESERVED_PARAMETER_NAMES = new Set(['selection', 'offset', 'limit', 'filters']);
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parameterNames(overrides?: FilterParameterNames): Record<keyof SampleFilters, string> {
  if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))) {
    throw new Error('Filter parameter names must be an object.');
  }
  const mapping = { ...DEFAULT_PARAMETER_NAMES };
  for (const [field, name] of Object.entries(overrides ?? {})) {
    if (!FILTER_FIELDS.some((candidate) => candidate === field)) {
      throw new Error(`Unknown filter field in parameter names: ${field}`);
    }
    if (typeof name !== 'string' || !PARAMETER_NAME_PATTERN.test(name) || RESERVED_PARAMETER_NAMES.has(name)) {
      throw new Error(`Invalid or reserved filter parameter name for ${field}.`);
    }
    mapping[field as keyof SampleFilters] = name;
  }
  if (new Set(Object.values(mapping)).size !== FILTER_FIELDS.length) {
    throw new Error('Filter parameter names must be unique.');
  }
  return mapping;
}

function namespacePrefix(namespace: string): string {
  if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error('Filter namespace must contain 1–64 letters, digits, underscores or hyphens.');
  }
  return `sf.${namespace}.`;
}

function filterValues(filters: SampleFilters): ReadonlyMap<keyof SampleFilters, string | null> {
  validateFilters(filters);
  return new Map<keyof SampleFilters, string | null>([
    ['biome', filters.biome],
    ['dateFrom', filters.dateFrom],
    ['dateTo', filters.dateTo],
    ['n50MinBp', filters.n50MinBp === null ? null : String(filters.n50MinBp)],
    ['n50MaxBp', filters.n50MaxBp === null ? null : String(filters.n50MaxBp)],
    ['taxonId', filters.taxonId],
    ['includeDescendants', filters.includeDescendants ? 'true' : null],
  ]);
}

/** Serialize only active filters; API names may be overridden from the fixed field allowlist. */
export function serializeApiFilters(
  filters: SampleFilters,
  names?: FilterParameterNames,
): URLSearchParams {
  const mapping = parameterNames(names);
  const params = new URLSearchParams();
  for (const [field, value] of filterValues(filters)) {
    if (value !== null) params.set(mapping[field], value);
  }
  return params;
}

/**
 * Create changes for exactly one widget's owned keys.
 * Null means delete. Apply this patch to the host's latest query state, not an old snapshot.
 */
export function createFilterQueryPatch(
  filters: SampleFilters,
  { namespace }: { namespace: string },
): ReadonlyMap<string, string | null> {
  const prefix = namespacePrefix(namespace);
  return new Map([...filterValues(filters)].map(([field, value]) => [
    `${prefix}${DEFAULT_PARAMETER_NAMES[field]}`, value,
  ]));
}

function parseInteger(value: string, key: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Filter query parameter ${key} must be a nonnegative decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Filter query parameter ${key} is outside the supported integer range.`);
  return parsed;
}

/** Read only this namespace's exact owned keys. Foreign keys, including future fields, are ignored. */
export function readFilterQuery(
  params: URLSearchParams,
  { namespace }: { namespace: string },
): SampleFilters {
  const prefix = namespacePrefix(namespace);
  const filters: Partial<SampleFilters> = {};
  for (const field of FILTER_FIELDS) {
    const key = `${prefix}${DEFAULT_PARAMETER_NAMES[field]}`;
    const values = params.getAll(key);
    if (values.length > 1) throw new Error(`Filter query parameter ${key} must appear only once.`);
    const value = values[0];
    if (value === undefined) continue;
    if (field === 'n50MinBp' || field === 'n50MaxBp') {
      filters[field] = parseInteger(value, key);
    } else if (field === 'includeDescendants') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Filter query parameter ${key} must be true or false.`);
      }
      filters[field] = value === 'true';
    } else {
      filters[field] = value;
    }
  }
  return normalizeFilters(filters);
}

/** Apply explicit changes to a fresh clone; unrelated parameters and repeated values survive. */
export function applyFilterQueryPatch(
  current: URLSearchParams,
  patch: ReadonlyMap<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of patch) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/** Internal helper for the HTTP adapter: clear every mapped filter key, then add active values. */
export function applyApiFilters(
  current: URLSearchParams,
  filters: SampleFilters,
  names?: FilterParameterNames,
): URLSearchParams {
  const mapping = parameterNames(names);
  const next = new URLSearchParams(current);
  for (const key of Object.values(mapping)) next.delete(key);
  for (const [key, value] of serializeApiFilters(filters, names)) next.set(key, value);
  return next;
}

/** Validate a custom mapping when constructing an adapter, before its first request. */
export function validateFilterParameterNames(names?: FilterParameterNames): void {
  parameterNames(names);
}
