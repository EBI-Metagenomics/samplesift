import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { AssemblyEvidence, Sample, SampleDataSource, SampleFilters } from '../types';
import { validateSample, validateSearchQuery } from './validation';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function matchesAssembly(assembly: AssemblyEvidence, filters: SampleFilters): boolean {
  const { n50MinBp, n50MaxBp, taxonId, includeDescendants } = filters;
  if (n50MinBp !== null || n50MaxBp !== null) {
    if (assembly.contigN50Bp === null) return false;
    if (n50MinBp !== null && assembly.contigN50Bp < n50MinBp) return false;
    if (n50MaxBp !== null && assembly.contigN50Bp > n50MaxBp) return false;
  }
  if (taxonId !== null && !assembly.taxa.some((taxon) => taxon.id === taxonId
    || (includeDescendants && taxon.ancestorIds?.includes(taxonId)))) return false;
  return true;
}

/** In-memory demo/test adapter. Facets and totals describe all matches, before pagination. */
export function createFixtureDataSource(samples: readonly Sample[], options: { latencyMs?: number } = {}): SampleDataSource {
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('Fixture latencyMs must be a nonnegative number.');
  const accessions = new Set<string>();
  const records = samples.map((sample) => {
    validateSample(sample);
    if (accessions.has(sample.accession)) throw new Error(`Duplicate fixture accession: ${sample.accession}`);
    accessions.add(sample.accession);
    return structuredClone(sample);
  }).sort((a, b) => a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0);

  return {
    async search(query, { signal }) {
      throwIfAborted(signal);
      validateSearchQuery(query);
      // Capture the request before yielding, so callers cannot change an in-flight query.
      const request = structuredClone(query);
      await delay(latencyMs, signal);
      throwIfAborted(signal);
      const { biome, dateFrom, dateTo, n50MinBp, n50MaxBp, taxonId } = request.filters;
      const hasAssemblyFilter = n50MinBp !== null || n50MaxBp !== null || taxonId !== null;
      const matching = records.filter((sample) => {
        if (request.selection && !booleanPointInPolygon([sample.longitude, sample.latitude], request.selection, { ignoreBoundary: false })) return false;
        if (biome !== null && sample.biome !== biome) return false;
        if (dateFrom !== null || dateTo !== null) {
          if (sample.collectionDate === null) return false;
          if (dateFrom !== null && sample.collectionDate < dateFrom) return false;
          if (dateTo !== null && sample.collectionDate > dateTo) return false;
        }
        // All assembly-level criteria must match one evidence record, not separate assemblies.
        if (hasAssemblyFilter && !sample.assemblies?.some((assembly) => matchesAssembly(assembly, request.filters))) return false;
        return true;
      });
      const biomeCounts = new Map<string, number>();
      for (const sample of matching) biomeCounts.set(sample.biome, (biomeCounts.get(sample.biome) ?? 0) + 1);
      throwIfAborted(signal);
      return {
        items: structuredClone(matching.slice(request.offset, request.offset + request.limit)),
        total: matching.length,
        facets: {
          biomes: [...biomeCounts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([value, count]) => ({ value, count })),
        },
      };
    },
  };
}
