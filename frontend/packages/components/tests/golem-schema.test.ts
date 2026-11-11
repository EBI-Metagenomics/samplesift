import { describe, expect, it } from 'vitest';
import type { Predicate, QueryableField } from '../src/collection/types';
import {
  createCollectionFilterDefinition, deriveCollectionFilterSchema,
  formDataToPredicates, predicatesToFormData,
} from '../src/components/collection-filter-schema';

const fields: QueryableField[] = [
  { name: 'depth', kind: 'number', nullable: true, operators: ['=', '<>', 'in', 'isNull', '>', '>=', '<', '<='] },
  { name: 'date', kind: 'date', nullable: true, operators: ['=', 'in', 'isNull', '>=', '<='] },
  { name: 'name', kind: 'string', nullable: true, operators: ['=', '<>', 'in', 'isNull'] },
  { name: 'verified', kind: 'boolean', nullable: true, operators: ['=', 'in', 'isNull'] },
];

function data() { return predicatesToFormData([], fields); }

describe('backend-driven Golem filter form', () => {
  it('roundtrips comparison, inclusive range, list, date and null predicates', () => {
    const predicates: Predicate[] = [
      { field: 'depth', operator: '>=', value: 0 }, { field: 'depth', operator: '<=', value: 25.5 },
      { field: 'date', operator: '=', value: '2024-02-29' },
      { field: 'name', operator: 'in', value: ['One, two', 'Contains spaces'] },
      { field: 'verified', operator: 'isNull' },
    ];
    expect(formDataToPredicates(predicatesToFormData(predicates, fields), fields)).toEqual(predicates);
    const single: Predicate[] = [{ field: 'depth', operator: '>', value: -3 }];
    expect(formDataToPredicates(predicatesToFormData(single, fields), fields)).toEqual(single);
  });

  it('converts numeric and boolean list tokens without treating blanks as zero', () => {
    const draft = data();
    draft.f0 = { operator: 'in', values: ['0', '-1.5', '2e3'] };
    draft.f3 = { operator: 'in', values: ['false', 'true'] };
    expect(formDataToPredicates(draft, fields)).toEqual([
      { field: 'depth', operator: 'in', value: [0, -1.5, 2000] },
      { field: 'verified', operator: 'in', value: [false, true] },
    ]);
    for (const values of [[], [''], [' '], ['Infinity'], ['12oops'], ['0x10']]) {
      draft.f0 = { operator: 'in', values };
      expect(() => formDataToPredicates(draft, fields)).toThrow();
    }
  });

  it('blocks incomplete and invalid drafts, inverted ranges and nonexistent dates', () => {
    const draft = data();
    for (const row of [
      { operator: '=', value: undefined }, { operator: '=', value: '12' },
      { operator: '=', value: Number.NaN }, { operator: 'range' },
      { operator: 'range', minimum: 3, maximum: 1 }, { operator: 'unadvertised', value: 4 },
    ]) {
      draft.f0 = row;
      expect(() => formDataToPredicates(draft, fields)).toThrow();
    }
    draft.f0 = { operator: 'any' };
    draft.f1 = { operator: '=', value: '2025-02-29' };
    expect(() => formDataToPredicates(draft, fields)).toThrow('valid date');
  });

  it('distinguishes no filter, explicit null, zero and false', () => {
    expect(formDataToPredicates(data(), fields)).toEqual([]);
    const draft = data();
    draft.f0 = { operator: '=', value: 0 };
    draft.f2 = { operator: 'isNull', value: 'stale hidden text' };
    draft.f3 = { operator: '=', value: false };
    expect(formDataToPredicates(draft, fields)).toEqual([
      { field: 'depth', operator: '=', value: 0 },
      { field: 'name', operator: 'isNull' },
      { field: 'verified', operator: '=', value: false },
    ]);
  });

  it('rejects unsupported saved conditions without silently simplifying them', () => {
    expect(() => predicatesToFormData([{ field: 'gone', operator: '=', value: 1 }], fields)).toThrow('not available');
    expect(() => predicatesToFormData([{ field: 'name', operator: '>', value: 'a' }], fields)).toThrow('unavailable operator');
    expect(() => predicatesToFormData([
      { field: 'depth', operator: '>', value: 1 }, { field: 'depth', operator: '<', value: 5 },
    ], fields)).toThrow('cannot be represented');
  });

  it('uses safe internal paths and ignores backend widget or expression hints', () => {
    const unusual: QueryableField[] = [{
      name: 'name.with[punctuation]', kind: 'string', operators: ['='], nullable: false,
      schema: { 'x-golemui': { widget: 'markdown', label: 'untrusted' } },
    }];
    const schema = deriveCollectionFilterSchema(unusual);
    expect(Object.keys(schema.properties as object)).toEqual(['f0']);
    const definition = createCollectionFilterDefinition(unusual);
    const serialized = JSON.stringify(definition);
    expect(serialized).toContain('f0.operator');
    expect(serialized).not.toContain('untrusted');
    expect(serialized).not.toContain('"type":"markdown"');
    expect(formDataToPredicates({ f0: { operator: '=', value: 'matched' } }, unusual)).toEqual([
      { field: 'name.with[punctuation]', operator: '=', value: 'matched' },
    ]);
  });

  it('generates conditional forms for advertised operators without conversion warnings', () => {
    const definition = createCollectionFilterDefinition(fields);
    expect(definition.states?.f0Range).toBe('$form.f0.operator === "range"');
    expect(definition.form.at(-1)).toMatchObject({ actionType: 'submit', label: 'Apply filters' });
    expect(JSON.stringify(definition)).toContain('filter-draft');
    expect(JSON.stringify(definition)).not.toContain('"type":"dateInput"');
    expect(JSON.stringify(definition)).toContain('YYYY-MM-DD');
    const integer: QueryableField[] = [{ name: 'count', kind: 'integer', operators: ['='], nullable: false }];
    expect(() => formDataToPredicates({ f0: { operator: '=', value: 1.5 } }, integer)).toThrow('whole number');
  });
});
