import { describe, expect, it } from 'vitest';
import { fieldLabel, summarizeCollectionFilters } from '../src/collection/presentation';
import type { Predicate, QueryableField } from '../src/collection/types';

const fields: QueryableField[] = [
  { name: 'depth', kind: 'number', nullable: true, operators: ['=', '<>', '>', '>=', '<', '<=', 'in', 'isNull'] },
  { name: 'name', kind: 'string', nullable: true, operators: ['=', '<>', 'in', 'isNull'] },
  { name: 'date', title: 'Collection date', kind: 'date', nullable: true, operators: ['=', '>=', '<=', 'in'] },
  { name: 'verified', kind: 'boolean', nullable: false, operators: ['=', 'in'] },
];

describe('collection filter presentation', () => {
  it('preserves declared titles and humanizes fallback names', () => {
    expect(fieldLabel({ name: 'lon', title: 'Longitude (°E)' })).toBe('Longitude (°E)');
    expect(fieldLabel({ name: 'lon' })).toBe('Longitude');
    expect(fieldLabel({ name: 'lat' })).toBe('Latitude');
    expect(fieldLabel({ name: 'collection_date' })).toBe('Collection date');
    expect(fieldLabel({ name: 'sample-name' })).toBe('Sample name');
    expect(fieldLabel({ name: 'collectionDate' })).toBe('Collection Date');
    expect(fieldLabel({ name: 'DNASequence' })).toBe('DNA Sequence');
    expect(fieldLabel({ name: 'constructor' })).toBe('Constructor');
  });

  it('groups in first-use order and preserves exact quoted text', () => {
    expect(summarizeCollectionFilters([
      { field: 'name', operator: '=', value: ' Gadus "north" ' },
      { field: 'depth', operator: '>=', value: 50 },
    ], fields)).toEqual([
      { field: 'name', label: 'Name', summary: 'Name = " Gadus \\"north\\" "' },
      { field: 'depth', label: 'Depth', summary: 'Depth ≥ 50' },
    ]);
  });

  it('combines only an exact inclusive pair, including ISO dates', () => {
    expect(summarizeCollectionFilters([
      { field: 'depth', operator: '<=', value: 50 },
      { field: 'date', operator: '>=', value: '1850-01-01' },
      { field: 'depth', operator: '>=', value: 10 },
      { field: 'date', operator: '<=', value: '1960-12-31' },
    ], fields).map(item => item.summary)).toEqual([
      'Depth: 10–50', 'Collection date: 1850-01-01–1960-12-31',
    ]);
  });

  it('shows every condition in a valid combination beyond the compact editor', () => {
    expect(summarizeCollectionFilters([
      { field: 'depth', operator: '>=', value: 10 },
      { field: 'depth', operator: '<=', value: 50 },
      { field: 'depth', operator: '<>', value: 20 },
      { field: 'depth', operator: '<>', value: 30 },
    ], fields)).toEqual([
      { field: 'depth', label: 'Depth', summary: 'Depth ≥ 10 and ≤ 50 and ≠ 20 and ≠ 30' },
    ]);
  });

  it('distinguishes lists, booleans, missing values and exact numeric precision', () => {
    expect(summarizeCollectionFilters([
      { field: 'name', operator: 'in', value: ['one, two', 'three'] },
      { field: 'verified', operator: '=', value: false },
      { field: 'depth', operator: '<', value: 0.1234567890123456 },
      { field: 'unknown_field', operator: 'isNull' },
    ], fields).map(item => item.summary)).toEqual([
      'Name is one of ["one, two", "three"]', 'Verified = false',
      'Depth < 0.1234567890123456', 'unknown_field is missing',
    ]);
    expect(summarizeCollectionFilters([{ field: 'name', operator: 'isNull' }], fields)[0].summary).toBe('Name is missing');
    expect(summarizeCollectionFilters([{ field: 'date', operator: 'in', value: ['1850-01-01', '1960-12-31'] }], fields)[0].summary)
      .toBe('Collection date is one of [1850-01-01, 1960-12-31]');
  });

  it('does not mutate input and represents an empty filter set as empty', () => {
    const predicates: Predicate[] = [{ field: 'name', operator: 'in', value: ['a', 'b'] }];
    const snapshot = structuredClone({ predicates, fields });
    summarizeCollectionFilters(predicates, fields);
    expect({ predicates, fields }).toEqual(snapshot);
    expect(summarizeCollectionFilters([], fields)).toEqual([]);
  });
});
