import type { Polygon } from 'geojson';
import type { Sample, SearchQuery, SearchResult } from '../types';
import { isValidDate, isTaxonId, validateFilters } from './filters';
export { isValidDate } from './filters';

const EPSILON = 1e-12;
type Point = [number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidCoordinate(longitude: unknown, latitude: unknown): boolean {
  return typeof longitude === 'number' && Number.isFinite(longitude)
    && longitude >= -180 && longitude <= 180
    && typeof latitude === 'number' && Number.isFinite(latitude)
    && latitude >= -90 && latitude <= 90;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.abs(cross(a, b, p)) <= EPSILON
    && p[0] >= Math.min(a[0], b[0]) - EPSILON
    && p[0] <= Math.max(a[0], b[0]) + EPSILON
    && p[1] >= Math.min(a[1], b[1]) - EPSILON
    && p[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d)
    || onSegment(c, d, a) || onSegment(c, d, b);
}

/** The MVP accepts one simple GeoJSON ring in longitude/latitude order. */
export function validatePolygon(value: unknown): asserts value is Polygon {
  if (!isRecord(value) || value.type !== 'Polygon' || !Array.isArray(value.coordinates)) {
    throw new Error('Selection must be a GeoJSON Polygon.');
  }
  if (value.coordinates.length !== 1) {
    throw new Error('Selection must have one outer ring; polygon holes are not supported.');
  }
  const ring = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 1001) {
    throw new Error('Selection must contain 3–1000 vertices and a closing coordinate.');
  }
  for (const position of ring) {
    if (!Array.isArray(position) || position.length !== 2
      || !isValidCoordinate(position[0], position[1])) {
      throw new Error('Selection coordinates must be [longitude, latitude] within valid geographic ranges.');
    }
  }
  const points = ring as Point[];
  if (!samePoint(points[0], points[points.length - 1])) {
    throw new Error('Selection polygon must be closed: its first and last coordinates must match.');
  }
  const edgeCount = points.length - 1;
  let twiceArea = 0;
  for (let i = 0; i < edgeCount; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (samePoint(a, b)) throw new Error('Selection has a repeated consecutive vertex.');
    // Longitude wrapping requires explicit handling outside this MVP.
    if (Math.abs(a[0] - b[0]) > 180) {
      throw new Error('Selections crossing the antimeridian are not supported.');
    }
    twiceArea += a[0] * b[1] - b[0] * a[1];
    const next = points[(i + 2) % edgeCount];
    if (Math.abs(cross(a, b, next)) <= EPSILON
      && (b[0] - a[0]) * (next[0] - b[0]) + (b[1] - a[1]) * (next[1] - b[1]) < 0) {
      throw new Error('Selection edges must not overlap or double back.');
    }
    for (let j = i + 1; j < edgeCount; j += 1) {
      if (j === i + 1 || (i === 0 && j === edgeCount - 1)) continue;
      if (segmentsIntersect(a, b, points[j], points[j + 1])) {
        throw new Error('Selection must be a simple polygon without crossing or touching edges.');
      }
    }
  }
  if (Math.abs(twiceArea) <= EPSILON) throw new Error('Selection polygon must enclose an area.');
}

export function validateSearchQuery(value: unknown): asserts value is SearchQuery {
  if (!isRecord(value)) throw new Error('Search query must be an object.');
  if (value.selection !== null) validatePolygon(value.selection);
  validateFilters(value.filters);
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) {
    throw new Error('Search offset must be a nonnegative integer.');
  }
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1) {
    throw new Error('Search limit must be a positive integer.');
  }
}

export function validateSample(value: unknown): asserts value is Sample {
  if (!isRecord(value) || !isNonemptyString(value.accession)
    || !isNonemptyString(value.title) || !isNonemptyString(value.biome)
    || !isValidCoordinate(value.longitude, value.latitude)
    || (value.collectionDate !== null && !isValidDate(value.collectionDate))) {
    throw new Error('A sample must have an accession, title, biome, valid coordinates and a valid collection date or null.');
  }
  if (value.assemblies !== undefined) {
    if (!Array.isArray(value.assemblies)) throw new Error('Sample assemblies must be an array.');
    const accessions = new Set<string>();
    for (const assembly of value.assemblies) {
      if (!isRecord(assembly) || !isNonemptyString(assembly.accession)
        || (assembly.contigN50Bp !== null && (typeof assembly.contigN50Bp !== 'number'
          || !Number.isSafeInteger(assembly.contigN50Bp) || assembly.contigN50Bp < 1))
        || !Array.isArray(assembly.taxa)) throw new Error('Assembly evidence requires an accession, positive integer contigN50Bp or null, and taxa.');
      if (accessions.has(assembly.accession)) throw new Error('Assembly evidence accessions must be unique within a sample.');
      accessions.add(assembly.accession);
      for (const taxon of assembly.taxa) {
        if (!isRecord(taxon) || !isTaxonId(taxon.id)
          || (taxon.label !== undefined && !isNonemptyString(taxon.label))
          || (taxon.ancestorIds !== undefined && (!Array.isArray(taxon.ancestorIds) || !taxon.ancestorIds.every(isTaxonId)))) {
          throw new Error('Taxon evidence requires namespaced identifiers and optional label and ancestorIds.');
        }
      }
    }
  }
  if (value.sourceUrl !== undefined) {
    let validUrl = false;
    if (typeof value.sourceUrl === 'string') {
      try { validUrl = ['http:', 'https:'].includes(new URL(value.sourceUrl).protocol); } catch { /* Invalid URL. */ }
    }
    if (!validUrl) throw new Error('Sample sourceUrl must be an absolute HTTP or HTTPS URL.');
  }
}

export function validateSearchResult(value: unknown, query?: SearchQuery): asserts value is SearchResult {
  if (!isRecord(value) || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.total) || (value.total as number) < 0
    || !isRecord(value.facets) || !Array.isArray(value.facets.biomes)) {
    throw new Error('Search response must contain items, a nonnegative integer total and biome facets.');
  }
  if (value.items.length > (value.total as number) || (query && value.items.length > query.limit)) {
    throw new Error('Search response contains more items than its total or requested page size.');
  }
  const accessions = new Set<string>();
  for (const item of value.items) {
    validateSample(item);
    if (accessions.has(item.accession)) throw new Error('Search response contains duplicate sample accessions.');
    accessions.add(item.accession);
  }
  const facetValues = new Set<string>();
  for (const facet of value.facets.biomes) {
    if (!isRecord(facet) || !isNonemptyString(facet.value)
      || !Number.isSafeInteger(facet.count) || (facet.count as number) < 0
      || (facet.count as number) > (value.total as number) || facetValues.has(facet.value)) {
      throw new Error('Biome facets must have unique values and integer counts between zero and the total.');
    }
    facetValues.add(facet.value);
  }
}
