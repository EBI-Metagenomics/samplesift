import { EMPTY_FILTERS } from '../types';
import type { SampleFilters } from '../types';

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** IDs include a reference namespace, such as ncbi:562 or gtdb:RS_GCF_000005845.2. */
export function isTaxonId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]*:[^\s]+$/i.test(value);
}

export function validateFilters(value: unknown): asserts value is SampleFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Search filters must be an object.');
  const filters = value as Record<string, unknown>;
  for (const key of Object.keys(filters)) {
    if (!Object.hasOwn(EMPTY_FILTERS, key)) throw new Error(`Unsupported filter: ${key}.`);
  }
  const { biome, dateFrom, dateTo, n50MinBp, n50MaxBp, taxonId, includeDescendants } = filters;
  if (biome !== null && (typeof biome !== 'string' || !biome.trim())) throw new Error('Biome must be a nonempty string or null.');
  if (dateFrom !== null && !isValidDate(dateFrom)) throw new Error('Start date must be a valid YYYY-MM-DD date or null.');
  if (dateTo !== null && !isValidDate(dateTo)) throw new Error('End date must be a valid YYYY-MM-DD date or null.');
  if (typeof dateFrom === 'string' && typeof dateTo === 'string' && dateFrom > dateTo) {
    throw new Error('Start date must be on or before the end date.');
  }
  for (const [name, bound] of [['Minimum N50', n50MinBp], ['Maximum N50', n50MaxBp]] as const) {
    if (bound !== null && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 1)) {
      throw new Error(`${name} must be a positive integer in base pairs or null.`);
    }
  }
  if (typeof n50MinBp === 'number' && typeof n50MaxBp === 'number' && n50MinBp > n50MaxBp) {
    throw new Error('Minimum N50 must be less than or equal to maximum N50.');
  }
  if (taxonId !== null && !isTaxonId(taxonId)) throw new Error('Taxonomy must use a namespaced identifier, for example ncbi:562, or null.');
  if (typeof includeDescendants !== 'boolean') throw new Error('includeDescendants must be a boolean.');
}

/** Fill missing known fields, while rejecting unsupported or explicitly invalid values. */
export function normalizeFilters(input: Partial<SampleFilters>): SampleFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Search filters must be an object.');
  const filters = { ...EMPTY_FILTERS, ...input };
  validateFilters(filters);
  return filters;
}
