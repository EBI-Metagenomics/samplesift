import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Polygon } from 'geojson';
import { createDemoSamples, createFixtureDataSource } from '../src/data';
import { EMPTY_FILTERS } from '../src/types';
import type { AssemblyEvidence, Sample, SampleFilters, SearchQuery, TaxonEvidence } from '../src/types';

const bacterium: TaxonEvidence = { id: 'ncbi:562', label: 'Escherichia coli', ancestorIds: ['ncbi:2', 'ncbi:561'] };
const archaeon: TaxonEvidence = { id: 'ncbi:2157', label: 'Archaea', ancestorIds: [] };
const assembly = (accession: string, contigN50Bp: number | null, taxa: TaxonEvidence[] = []): AssemblyEvidence => ({
  accession, contigN50Bp, taxa: structuredClone(taxa),
});
const sample = (accession: string, assemblies?: AssemblyEvidence[], overrides: Partial<Sample> = {}): Sample => ({
  accession, title: `Synthetic sample ${accession}`, longitude: 5, latitude: 5,
  biome: 'Marine', collectionDate: '2024-01-01', assemblies, ...overrides,
});
const query = (filters: Partial<SampleFilters> = {}, overrides: Partial<Omit<SearchQuery, 'filters'>> = {}): SearchQuery => ({
  selection: null, filters: { ...EMPTY_FILTERS, ...filters }, offset: 0, limit: 20, ...overrides,
});
const options = () => ({ signal: new AbortController().signal });
const accessions = (samples: Sample[]) => samples.map((item) => item.accession);

function firstEvidence(record: Sample): { assembly: AssemblyEvidence; taxon: TaxonEvidence; ancestors: string[] } {
  const firstAssembly = record.assemblies?.[0];
  const taxon = firstAssembly?.taxa[0];
  const ancestors = taxon?.ancestorIds;
  if (!firstAssembly || !taxon || !ancestors) throw new Error('Expected nested assembly evidence in the test fixture.');
  return { assembly: firstAssembly, taxon, ancestors };
}

afterEach(() => vi.useRealTimers());

describe('assembly evidence filtering', () => {
  it('requires N50 and taxonomy to match the same assembly', async () => {
    const source = createFixtureDataSource([
      sample('CROSS-ASSEMBLY', [assembly('high-wrong-taxon', 100_000, [archaeon]), assembly('low-right-taxon', 1_000, [bacterium])]),
      sample('SAME-ASSEMBLY', [assembly('high-right-taxon', 100_000, [bacterium])]),
    ]);
    expect((await source.search(query({ n50MinBp: 50_000 }), options())).total).toBe(2);
    expect((await source.search(query({ taxonId: 'ncbi:562' }), options())).total).toBe(2);
    const combined = await source.search(query({ n50MinBp: 50_000, taxonId: 'ncbi:562' }), options());
    expect(accessions(combined.items)).toEqual(['SAME-ASSEMBLY']);
  });

  it('uses inclusive N50 bounds and excludes unknown N50 only while a bound is active', async () => {
    const source = createFixtureDataSource([
      sample('A-LOWER', [assembly('a', 10_000, [bacterium])]),
      sample('B-MIDDLE', [assembly('b', 25_000, [bacterium])]),
      sample('C-UPPER', [assembly('c', 50_000, [bacterium])]),
      sample('D-BELOW', [assembly('d', 9_999, [bacterium])]),
      sample('E-ABOVE', [assembly('e', 50_001, [bacterium])]),
      sample('F-UNKNOWN', [assembly('f', null, [bacterium])]),
    ]);
    const bounded = await source.search(query({ n50MinBp: 10_000, n50MaxBp: 50_000 }), options());
    expect(accessions(bounded.items)).toEqual(['A-LOWER', 'B-MIDDLE', 'C-UPPER']);
    const exact = await source.search(query({ n50MinBp: 10_000, n50MaxBp: 10_000 }), options());
    expect(accessions(exact.items)).toEqual(['A-LOWER']);
    const minimum = await source.search(query({ n50MinBp: 50_000 }), options());
    expect(accessions(minimum.items)).toEqual(['C-UPPER', 'E-ABOVE']);
    const maximum = await source.search(query({ n50MaxBp: 10_000 }), options());
    expect(accessions(maximum.items)).toEqual(['A-LOWER', 'D-BELOW']);
    const taxonomyOnly = await source.search(query({ taxonId: 'ncbi:562' }), options());
    expect(accessions(taxonomyOnly.items)).toContain('F-UNKNOWN');
  });

  it('matches exact taxon identifiers and only expands explicitly recorded ancestors', async () => {
    const source = createFixtureDataSource([
      sample('A-EXACT', [assembly('a', 10_000, [{ id: 'ncbi:2', label: 'Bacteria' }])]),
      sample('B-DESCENDANT', [assembly('b', 10_000, [bacterium])]),
      sample('C-LABEL-ONLY', [assembly('c', 10_000, [{ id: 'ncbi:2157', label: 'Bacteria' }])]),
      sample('D-NO-LINEAGE', [assembly('d', 10_000, [{ id: 'ncbi:562', label: 'Escherichia coli' }])]),
    ]);
    const exact = await source.search(query({ taxonId: 'ncbi:2' }), options());
    expect(accessions(exact.items)).toEqual(['A-EXACT']);
    const descendants = await source.search(query({ taxonId: 'ncbi:2', includeDescendants: true }), options());
    expect(accessions(descendants.items)).toEqual(['A-EXACT', 'B-DESCENDANT']);
    const species = await source.search(query({ taxonId: 'ncbi:562', includeDescendants: true }), options());
    expect(accessions(species.items)).toEqual(['B-DESCENDANT', 'D-NO-LINEAGE']);
  });

  it('keeps samples without assemblies until an assembly filter is active', async () => {
    const source = createFixtureDataSource([
      sample('A-MISSING'), sample('B-EMPTY', []), sample('C-EVIDENCE', [assembly('c', 20_000, [bacterium])]),
    ]);
    expect((await source.search(query(), options())).total).toBe(3);
    expect((await source.search(query({ includeDescendants: true }), options())).total).toBe(3);
    expect(accessions((await source.search(query({ n50MinBp: 1 }), options())).items)).toEqual(['C-EVIDENCE']);
    expect(accessions((await source.search(query({ taxonId: 'ncbi:562' }), options())).items)).toEqual(['C-EVIDENCE']);
  });

  it('counts a sample once and computes total and facets before pagination', async () => {
    const source = createFixtureDataSource([
      sample('A', [assembly('a-1', 30_000, [bacterium]), assembly('a-2', 40_000, [bacterium])]),
      sample('B', [assembly('b', 50_000, [bacterium])], { biome: 'Soil' }),
      sample('C', [assembly('c', 1_000, [bacterium])]),
    ]);
    const firstPage = await source.search(query({ n50MinBp: 20_000, taxonId: 'ncbi:562' }, { limit: 1 }), options());
    expect(accessions(firstPage.items)).toEqual(['A']);
    expect(firstPage.total).toBe(2);
    expect(firstPage.facets.biomes).toEqual([{ value: 'Marine', count: 1 }, { value: 'Soil', count: 1 }]);
    const secondPage = await source.search(query({ n50MinBp: 20_000, taxonId: 'ncbi:562' }, { offset: 1, limit: 1 }), options());
    expect(accessions(secondPage.items)).toEqual(['B']);
    expect(secondPage.total).toBe(firstPage.total);
    expect(secondPage.facets).toEqual(firstPage.facets);
    const emptyPage = await source.search(query({ n50MinBp: 20_000, taxonId: 'ncbi:562' }, { offset: 2, limit: 1 }), options());
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.total).toBe(2);
  });

  it('rejects duplicate assembly accessions within a sample without conflating different samples', async () => {
    expect(() => createFixtureDataSource([sample('DUPLICATE', [
      assembly('same-accession', 10_000, [bacterium]), assembly('same-accession', 50_000, [archaeon]),
    ])])).toThrow('unique within a sample');
    const source = createFixtureDataSource([
      sample('A', [assembly('shared-accession', 10_000)]),
      sample('B', [assembly('shared-accession', 50_000)]),
    ]);
    expect((await source.search(query({ n50MinBp: 10_000 }), options())).total).toBe(2);
    expect((await source.search(query({ n50MinBp: 10_000, taxonId: 'ncbi:2' }), options())).total).toBe(0);
  });

  it('ANDs assembly evidence with spatial, biome and date filters', async () => {
    const evidence = [assembly('evidence', 50_000, [bacterium])];
    const source = createFixtureDataSource([
      sample('A-ALL', evidence),
      sample('B-OUTSIDE', evidence, { longitude: 30 }),
      sample('C-BIOME', evidence, { biome: 'Soil' }),
      sample('D-DATE', evidence, { collectionDate: '2023-12-31' }),
      sample('E-UNKNOWN-DATE', evidence, { collectionDate: null }),
    ]);
    const selection: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const result = await source.search(query({
      biome: 'Marine', dateFrom: '2024-01-01', dateTo: '2024-01-01',
      n50MinBp: 50_000, n50MaxBp: 50_000, taxonId: 'ncbi:2', includeDescendants: true,
    }, { selection }), options());
    expect(accessions(result.items)).toEqual(['A-ALL']);
  });
});

describe('nested evidence snapshots', () => {
  it('isolates constructor input and returned assembly, taxa and ancestor arrays', async () => {
    const original = sample('A', [assembly('original', 50_000, [bacterium])]);
    const source = createFixtureDataSource([original]);
    const originalEvidence = firstEvidence(original);
    originalEvidence.assembly.contigN50Bp = 1;
    originalEvidence.taxon.id = 'ncbi:2157';
    originalEvidence.ancestors.splice(0, originalEvidence.ancestors.length, 'ncbi:2759');
    original.assemblies?.push(assembly('injected', 99_000, [archaeon]));
    const request = query({ n50MinBp: 40_000, taxonId: 'ncbi:2', includeDescendants: true });
    const first = await source.search(request, options());
    expect(accessions(first.items)).toEqual(['A']);
    const returned = first.items[0];
    if (!returned) throw new Error('Expected one matching sample.');
    const returnedEvidence = firstEvidence(returned);
    expect(returnedEvidence.assembly.contigN50Bp).toBe(50_000);
    expect(returned.assemblies).toHaveLength(1);
    returnedEvidence.assembly.contigN50Bp = 0;
    returnedEvidence.taxon.label = 'Changed by result consumer';
    returnedEvidence.ancestors.length = 0;
    returnedEvidence.assembly.taxa.push(archaeon);
    returned.assemblies?.push(assembly('result-injected', 500_000, [archaeon]));
    first.facets.biomes[0].count = 99;
    const next = await source.search(request, options());
    expect(next.total).toBe(1);
    expect(next.items[0].assemblies).toEqual([assembly('original', 50_000, [bacterium])]);
    expect(next.facets.biomes).toEqual([{ value: 'Marine', count: 1 }]);
  });

  it('captures nested geometry and filters before a delayed search yields', async () => {
    vi.useFakeTimers();
    const source = createFixtureDataSource([sample('A', [assembly('a', 50_000, [bacterium])])], { latencyMs: 20 });
    const selection: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const request = query({ n50MinBp: 40_000, taxonId: 'ncbi:2', includeDescendants: true }, { selection });
    const pending = source.search(request, options());
    request.filters.n50MinBp = 500_000;
    request.filters.taxonId = 'ncbi:2157';
    request.filters.includeDescendants = false;
    selection.coordinates[0][0][0] = 100;
    request.offset = 1;
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(accessions(result.items)).toEqual(['A']);
    expect(result.total).toBe(1);
  });
});

describe('synthetic assembly fixtures', () => {
  it('provides deterministic diverse evidence and independent nested objects', () => {
    const records = createDemoSamples();
    expect(records).toHaveLength(120);
    expect(records).toEqual(createDemoSamples());
    expect(records.some((record) => record.assemblies === undefined)).toBe(true);
    expect(records.some((record) => record.assemblies?.length === 0)).toBe(true);
    expect(records.some((record) => (record.assemblies?.length ?? 0) > 1)).toBe(true);
    expect(records.some((record) => record.assemblies?.some((entry) => entry.contigN50Bp === null))).toBe(true);
    expect(records.some((record) => record.assemblies?.some((entry) => entry.taxa.some((taxon) => taxon.ancestorIds?.length)))).toBe(true);
    expect(() => createFixtureDataSource(records)).not.toThrow();
    const record = records.find((item) => item.assemblies?.[0]?.taxa[0]?.ancestorIds?.length);
    if (!record) throw new Error('Expected a synthetic descendant taxon.');
    const before = structuredClone(records);
    firstEvidence(record).ancestors.push('ncbi:999999999');
    expect(createDemoSamples()).toEqual(before);
    expect(records.filter((item) => item.assemblies?.some((entry) => entry.taxa.some((taxon) => taxon.ancestorIds?.includes('ncbi:999999999'))))).toHaveLength(1);
  });
});
