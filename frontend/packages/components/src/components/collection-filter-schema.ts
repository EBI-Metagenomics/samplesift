import { fromJsonSchema } from '@golemui/schemas/json-schema';
import type { FormDefinitionJson, FormWidgetJson, JsonSchema } from '@golemui/schemas/json-schema';
import { guiPreset } from '@golemui/gui-schemas/json-schema';
import type { Operator, Predicate, QueryableField, Scalar } from '../collection/types';
import { fieldLabel } from '../collection/presentation';
import { validateFieldValue } from '../collection/schema';

export type FilterFormData = Record<string, Record<string, unknown>>;
const comparisons = new Set<string>(['=', '<>', '>', '>=', '<', '<=']);
export const filterOperatorLabels: Record<string, string> = {
  any: 'Any value', '=': 'Equals', '<>': 'Does not equal', in: 'One of', isNull: 'Is missing',
  '>': 'Greater than', '>=': 'At least', '<': 'Less than', '<=': 'At most', range: 'Inclusive range',
};

function supportsRange(field: QueryableField) {
  return field.kind !== 'boolean' && field.operators.includes('>=') && field.operators.includes('<=');
}

const scalarConstraints = ['enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern'] as const;

function valueSchema(field: QueryableField): JsonSchema {
  const schema: JsonSchema = field.kind === 'date'
    ? { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Use YYYY-MM-DD.' }
    : field.kind === 'date-time' ? { type: 'string', format: 'date-time', description: 'Date and time in UTC.' }
      : field.kind === 'boolean' ? { type: 'boolean', enum: [true, false] } : { type: field.kind };
  for (const key of scalarConstraints) {
    const value = field.schema?.[key];
    if (value === undefined || (key === 'const' && value === null)) continue;
    schema[key] = key === 'enum' && Array.isArray(value) ? value.filter(item => item !== null) : structuredClone(value);
  }
  return schema;
}

export function defaultFilterOperator(field: QueryableField): Operator | 'range' {
  if (['number', 'integer', 'date', 'date-time'].includes(field.kind) && supportsRange(field)
    && !field.schema?.enum && field.schema?.const === undefined) return 'range';
  if (field.operators.includes('=')) return '=';
  const operator = field.operators[0];
  if (!operator) throw new Error(`${fieldLabel(field)} has no supported conditions.`);
  return operator;
}

/** Equality is semantic: order changes in AND predicates or membership lists are not new searches. */
export function predicateStateKey(predicates: readonly Predicate[]): string {
  return JSON.stringify(predicates.map(predicate => {
    if (predicate.operator === 'isNull') return JSON.stringify({ field: predicate.field, operator: predicate.operator });
    const value = predicate.operator === 'in' ? [...new Set(predicate.value.map(item => JSON.stringify(item)))].sort() : predicate.value;
    return JSON.stringify({ field: predicate.field, operator: predicate.operator, value });
  }).sort());
}

/** Derive a fresh schema: backend widget hints and expression strings are never executed. */
export function deriveCollectionFilterSchema(fields: readonly QueryableField[], compact = false): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const names = new Set<string>();
  fields.forEach((field, index) => {
    if (!field.name || names.has(field.name)) throw new Error('Filter fields must have distinct names.');
    names.add(field.name);
    const title = fieldLabel(field);
    const operators = [...(compact ? [] : ['any']), ...field.operators, ...(supportsRange(field) ? ['range'] : [])];
    if (field.operators.some((operator) => !comparisons.has(operator) && operator !== 'in' && operator !== 'isNull')) {
      throw new Error(`Unsupported operator advertised for ${title}.`);
    }
    properties[`f${index}`] = {
      type: 'object', additionalProperties: false,
      properties: {
        operator: { type: 'string', title: compact ? 'Condition' : `${title}: condition`, description: field.description, enum: operators, default: compact ? defaultFilterOperator(field) : 'any' },
        value: { ...valueSchema(field), title: compact ? 'Value' : `${title}: value` },
        values: {
          type: 'array', title: compact ? 'Values' : `${title}: values`, items: { type: 'string' },
          description: field.kind === 'boolean' ? 'Enter true or false; press Enter after each value.'
            : field.kind === 'date' ? 'Use YYYY-MM-DD; press Enter after each date.'
              : field.kind === 'date-time' ? 'Use ISO timestamps with Z or a UTC offset; press Enter after each timestamp.'
              : 'Press Enter after each value.',
        },
        minimum: { ...valueSchema(field), title: compact ? (field.kind.startsWith('date') ? 'From' : 'Minimum') : `${title}: minimum` },
        maximum: { ...valueSchema(field), title: compact ? (field.kind.startsWith('date') ? 'To' : 'Maximum') : `${title}: maximum` },
      },
    };
  });
  return { type: 'object', properties, additionalProperties: false };
}

export function createCollectionFilterDefinition(fields: readonly QueryableField[], cardId?: string): FormDefinitionJson {
  const compact = cardId !== undefined;
  const { formDefinition, diagnostics } = fromJsonSchema(deriveCollectionFilterSchema(fields, compact), {
    preset: guiPreset({ submitLabel: 'Apply filters', submitAction: !compact, enumThresholds: { select: 12 } }), vendorKeyword: false,
    // The preset date widget clamps years below 1900 and defers draft commits on blur.
    // An ISO input preserves the full date contract; calendar validity is checked below.
    rules: [{ match: { format: 'date' }, widget: 'textinput', props: { placeholder: 'YYYY-MM-DD' } }],
  });
  const failures = diagnostics.filter((diagnostic) => diagnostic.severity !== 'info');
  if (failures.length) throw new Error(`Filter form could not be generated: ${failures.map((item) => item.message).join(' ')}`);
  const states: Record<string, string> = compact ? { advanced: '$meta.advanced === true' } : {};
  fields.forEach((field, index) => {
    const key = `f${index}`;
    states[`${key}Scalar`] = [...comparisons].filter((operator) => field.operators.includes(operator as Operator))
      .map((operator) => `$form.${key}.operator === ${JSON.stringify(operator)}`).join(' || ') || 'false';
    states[`${key}List`] = `$form.${key}.operator === "in"`;
    states[`${key}Range`] = `$form.${key}.operator === "range"`;
  });
  const decorate = (widgets: FormWidgetJson[]) => {
    for (const widget of widgets) {
      if (widget.children) decorate(widget.children);
      if (widget.kind !== 'input' || !widget.path) continue;
      if (widget.type === 'dateTimePicker') widget.props = { ...widget.props, hourFormat: '24', minuteStep: 1 };
      const [key, part] = widget.path.split('.');
      widget.on = { change: 'filter-draft' };
      if (cardId) widget.uid = `${cardId}-${widget.path.replaceAll('.', '-')}`;
      if (part === 'operator') {
        const field = fields[Number(key.slice(1))];
        const operators = [...(compact ? [] : ['any']), ...field.operators, ...(supportsRange(field) ? ['range'] : [])];
        if (compact) widget.include = { in: ['advanced'] };
        widget.props = { ...widget.props, options: operators.map((value) => ({ value, label: filterOperatorLabels[value] })) };
      } else {
        const state = part === 'values' ? 'List' : part === 'value' ? 'Scalar' : 'Range';
        widget.include = { in: [`${key}${state}`] };
      }
    }
  };
  decorate(formDefinition.form);
  return { ...formDefinition, states: { ...formDefinition.states, ...states } };
}

/** Golem omits hidden controls from event data; preserve only the selected condition. */
export function retainHiddenOperator(data: unknown, previous: FilterFormData): FilterFormData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Filter form values are unavailable.');
  const next = structuredClone(data) as FilterFormData;
  const row = next.f0;
  if (row !== undefined && (!row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid filter values.');
  if (row?.operator === undefined) next.f0 = { ...row, operator: previous.f0?.operator };
  return next;
}

/** Blank controls are distinct from the explicit isNull predicate. */
export function predicatesToFormData(predicates: readonly Predicate[], fields: readonly QueryableField[]): FilterFormData {
  const data: FilterFormData = {};
  const unknown = predicates.find((predicate) => !fields.some((field) => field.name === predicate.field));
  if (unknown) throw new Error(`The saved filter field ${unknown.field} is not available in this collection.`);
  fields.forEach((field, index) => {
    const matching = predicates.filter((predicate) => predicate.field === field.name);
    const row: Record<string, unknown> = { operator: 'any' };
    if (matching.some((predicate) => !field.operators.includes(predicate.operator))) {
      throw new Error(`The saved filter uses an unavailable operator for ${field.title || field.name}.`);
    }
    if (matching.length === 1) {
      const predicate = matching[0];
      row.operator = predicate.operator;
      if (predicate.operator === 'in') row.values = predicate.value.map(String);
      else if (predicate.operator !== 'isNull') row.value = pickerValue(predicate.value, field);
    } else if (matching.length > 1) {
      const lower = matching.find((predicate) => predicate.operator === '>=');
      const upper = matching.find((predicate) => predicate.operator === '<=');
      if (matching.length !== 2 || lower?.operator !== '>=' || upper?.operator !== '<=' || !supportsRange(field)) {
        throw new Error(`The saved filters for ${field.title || field.name} cannot be represented by this form. Clear them or restore a single condition or inclusive range.`);
      }
      row.operator = 'range'; row.minimum = pickerValue(lower.value, field); row.maximum = pickerValue(upper.value, field);
    }
    data[`f${index}`] = row;
  });
  return data;
}

function isBlank(value: unknown) { return value === undefined || value === null || value === ''; }

/** The existing picker uses wall time. Display UTC without rounding fractional seconds. */
function pickerValue(value: Scalar, field: QueryableField): Scalar {
  if (field.kind !== 'date-time' || field.schema?.enum || field.schema?.const !== undefined) return value;
  validateFieldValue(field, value);
  return new Date(value as string).toISOString().replace(/\.\d{3}Z$/, (value as string).match(/\.\d+/)?.[0] ?? '');
}

function readScalar(value: unknown, field: QueryableField, list = false): Scalar {
  const title = fieldLabel(field);
  if (isBlank(value)) throw new Error(`Enter a value for ${title}.`);
  if (field.kind === 'number' || field.kind === 'integer') {
    const number = list && typeof value === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())
      ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || (field.kind === 'integer' && !Number.isSafeInteger(number))) {
      throw new Error(`Enter ${field.kind === 'integer' ? 'a whole number' : 'a finite number'} for ${title}.`);
    }
    validateFieldValue(field, number);
    return number;
  }
  if (field.kind === 'boolean') {
    if (typeof value === 'boolean') { validateFieldValue(field, value); return value; }
    if (list && (value === 'true' || value === 'false')) { const boolean = value === 'true'; validateFieldValue(field, boolean); return boolean; }
    throw new Error(`Enter true or false for ${title}.`);
  }
  if (typeof value !== 'string') throw new Error(`Enter text for ${title}.`);
  // Calendar edits are UTC; membership lists and saved API state require an explicit offset.
  if (field.kind === 'date-time' && !list && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    const timestamp = `${value.length === 16 ? `${value}:00` : value}Z`;
    validateFieldValue(field, timestamp);
    return timestamp;
  }
  if (field.kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw new Error(`Enter a valid date (YYYY-MM-DD) for ${title}.`);
    }
  }
  validateFieldValue(field, value);
  return value;
}

export function formDataToPredicates(value: unknown, fields: readonly QueryableField[]): Predicate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Filter form values are unavailable.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.some((_, index) => key === `f${index}`))) throw new Error('The filter form contains an unknown field.');
  const predicates: Predicate[] = [];
  fields.forEach((field, index) => {
    const raw = data[`f${index}`];
    if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid filter for ${field.name}.`);
    const row = raw as Record<string, unknown>;
    const operator = row.operator;
    if (operator === 'any') return;
    if (operator === 'range' && supportsRange(field)) {
      const lower = isBlank(row.minimum) ? undefined : readScalar(row.minimum, field);
      const upper = isBlank(row.maximum) ? undefined : readScalar(row.maximum, field);
      if (lower === undefined && upper === undefined) throw new Error(`Enter at least one range bound for ${field.title || field.name}.`);
      const ordered = (value: Scalar) => field.kind === 'date-time' ? Date.parse(value as string) : value;
      if (lower !== undefined && upper !== undefined && ordered(lower) > ordered(upper)) throw new Error(`The minimum for ${field.title || field.name} must not exceed its maximum.`);
      if (lower !== undefined) predicates.push({ field: field.name, operator: '>=', value: lower });
      if (upper !== undefined) predicates.push({ field: field.name, operator: '<=', value: upper });
      return;
    }
    if (typeof operator !== 'string' || !field.operators.includes(operator as Operator)) throw new Error(`Choose an available condition for ${field.title || field.name}.`);
    if (operator === 'isNull') predicates.push({ field: field.name, operator });
    else if (operator === 'in') {
      if (!Array.isArray(row.values) || !row.values.length) throw new Error(`Add at least one value for ${field.title || field.name}.`);
      predicates.push({ field: field.name, operator, value: row.values.map((item) => readScalar(item, field, true)) });
    } else if (comparisons.has(operator)) {
      predicates.push({ field: field.name, operator: operator as Exclude<Operator, 'in' | 'isNull'>, value: readScalar(row.value, field) });
    } else throw new Error(`Unsupported condition for ${field.title || field.name}.`);
  });
  return predicates;
}
