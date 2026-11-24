import type { CollectionRecordPresentation, Predicate, QueryableField, Scalar } from './types';

/** Prefer the collection's own title; infer a readable label only when absent. */
export function fieldLabel(field: { name: string; title?: string }): string {
  if (field.title?.trim()) return field.title;
  if (field.name.toLowerCase() === 'lon') return 'Longitude';
  if (field.name.toLowerCase() === 'lat') return 'Latitude';
  const words = field.name
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field.name;
}

function displayValue(value: Scalar, field: QueryableField | undefined): string {
  if (typeof value !== 'string') return String(value);
  return field?.kind === 'date' || field?.kind === 'date-time' ? value : JSON.stringify(value);
}

function conditionSummary(predicate: Predicate, field: QueryableField | undefined): string {
  if (predicate.operator === 'isNull') return 'is missing';
  if (predicate.operator === 'in') {
    return `is one of [${predicate.value.map(value => displayValue(value, field)).join(', ')}]`;
  }
  const operator = predicate.operator === '>=' ? '≥'
    : predicate.operator === '<=' ? '≤'
      : predicate.operator === '<>' ? '≠' : predicate.operator;
  return `${operator} ${displayValue(predicate.value, field)}`;
}

/** Summarize every applied condition, including combinations the editor cannot represent. */
export function summarizeCollectionFilters(
  predicates: readonly Predicate[],
  fields: readonly QueryableField[],
): Array<{ field: string; label: string; summary: string }> {
  const metadata = new Map(fields.map(field => [field.name, field]));
  const grouped = new Map<string, Predicate[]>();
  for (const predicate of predicates) {
    const conditions = grouped.get(predicate.field) ?? [];
    conditions.push(predicate);
    grouped.set(predicate.field, conditions);
  }
  return [...grouped].map(([name, conditions]) => {
    const field = metadata.get(name);
    const label = field ? fieldLabel(field) : name;
    const lower = conditions.find(predicate => predicate.operator === '>=');
    const upper = conditions.find(predicate => predicate.operator === '<=');
    const summary = conditions.length === 2 && lower?.operator === '>=' && upper?.operator === '<='
      ? `${label}: ${displayValue(lower.value, field)}–${displayValue(upper.value, field)}`
      : `${label} ${conditions.map(predicate => conditionSummary(predicate, field)).join(' and ')}`;
    return { field: name, label, summary };
  });
}

/** The record's declared label, falling back to its source key. */
export function recordLabel(item: Record<string, unknown>, record: CollectionRecordPresentation | undefined): string {
  const value = record?.label ? item[record.label] : undefined;
  return value === null || value === undefined || value === '' ? String(item.source_pk ?? '') : String(value);
}

/** Fill a record URL template; missing values or non-http(s) results produce no link. */
export function recordUrl(item: Record<string, unknown>, record: CollectionRecordPresentation | undefined): string | undefined {
  if (!record?.url) return undefined;
  let missing = false;
  const filled = record.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = item[name];
    if (value === null || value === undefined || value === '') { missing = true; return ''; }
    return encodeURIComponent(String(value));
  });
  if (missing) return undefined;
  try {
    const url = new URL(filled);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}
