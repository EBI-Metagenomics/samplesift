import type { Sample } from '../types';

/** Synthetic illustration only: these identifiers and records do not refer to real samples. */
export function createDemoSamples(): Sample[] {
  const clusters = [
    { name: 'Western Mediterranean', biome: 'Marine', longitude: 4, latitude: 40, spreadX: 5, spreadY: 2 },
    { name: 'North Atlantic', biome: 'Marine', longitude: -34, latitude: 44, spreadX: 13, spreadY: 7 },
    { name: 'South Pacific', biome: 'Marine', longitude: -125, latitude: -29, spreadX: 16, spreadY: 8 },
    { name: 'Central Europe', biome: 'Soil', longitude: 11, latitude: 50, spreadX: 6, spreadY: 3 },
    { name: 'Amazon basin', biome: 'Soil', longitude: -62, latitude: -6, spreadX: 7, spreadY: 4 },
    { name: 'East Africa', biome: 'Soil', longitude: 36, latitude: 0, spreadX: 2, spreadY: 4 },
    { name: 'Great Lakes region', biome: 'Freshwater', longitude: -84, latitude: 45, spreadX: 2, spreadY: 1.5 },
    { name: 'Lake Victoria region', biome: 'Freshwater', longitude: 33, latitude: -1, spreadX: 0.5, spreadY: 0.5 },
  ];
  let seed = 613;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return clusters.flatMap((cluster, clusterIndex) => Array.from({ length: 15 }, (_, localIndex) => {
    const index = clusterIndex * 15 + localIndex + 1;
    const year = 2018 + Math.floor(random() * 7);
    const month = String(1 + Math.floor(random() * 12)).padStart(2, '0');
    const day = String(1 + Math.floor(random() * 28)).padStart(2, '0');
    return {
      accession: `DEMO-${String(index).padStart(4, '0')}`,
      title: `${cluster.name} · synthetic ${cluster.biome.toLowerCase()} sample ${localIndex + 1}`,
      longitude: Number((cluster.longitude + (random() * 2 - 1) * cluster.spreadX).toFixed(5)),
      latitude: Number((cluster.latitude + (random() * 2 - 1) * cluster.spreadY).toFixed(5)),
      biome: cluster.biome,
      collectionDate: index % 9 === 0 ? null : `${year}-${month}-${day}`,
    };
  }));
}
