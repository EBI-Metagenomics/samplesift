import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// One named dataset; API order is a bounded subset, not a random sample.
const datasetId = 'ad65221f-0539-44aa-925e-4acf62ad0c6a';
const api = 'https://api.obis.org/v3';
const limit = Number(process.argv[2] ?? 10000);
if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
  throw new Error('Record limit must be an integer from 1 to 100000.');
}
async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`OBIS HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
const metadata = (await getJson(`${api}/dataset/${datasetId}`)).results[0];
if (!metadata) throw new Error('OBIS dataset metadata is missing.');
const records = [];
const seen = new Set();
let inspected = 0;
let after;
let pages = 0;
while (inspected < limit) {
  const query = new URLSearchParams({
    datasetid: datasetId,
    size: String(Math.min(1000, limit - inspected)),
    fields: 'id,decimalLongitude,decimalLatitude,depth,date_start,eventDate,scientificName',
  });
  if (after) query.set('after', after);
  const page = await getJson(`${api}/occurrence?${query}`);
  if (!page.results?.length) break;
  pages++;
  for (const row of page.results) {
    inspected++;
    if (!row.id || seen.has(row.id)) throw new Error('Missing or repeated OBIS ID; pagination failed.');
    seen.add(row.id);
    const lon = row.decimalLongitude;
    const lat = row.decimalLatitude;
    const depth = row.depth;
    const dateMs = row.date_start;
    if (![lon, lat, depth, dateMs].every(Number.isFinite)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 85.05112878 || depth < 0) continue;
    const date = new Date(dateMs).toISOString().slice(0, 10);
    records.push({ id: row.id, lon, lat, depth, date, name: row.scientificName ?? 'Unknown' });
  }
  const next = page.last ?? page.results.at(-1).id;
  if (typeof next !== 'string' || next === after) throw new Error('Invalid OBIS pagination cursor.');
  after = next;
  console.log(`Inspected ${inspected}; retained ${records.length}`);
}
if (!records.length) throw new Error('No records have valid coordinates, depth and date.');
const source = {
  datasetId, title: metadata.title, citation: metadata.citation,
  license: metadata.intellectualrights,
  url: `https://obis.org/dataset/${datasetId}`,
  api: `${api}/occurrence?datasetid=${datasetId}`,
  retrievedAt: new Date().toISOString(), requested: limit, inspected,
  excluded: inspected - records.length, pages,
  selection: 'First API records by cursor; not a random or representative sample.',
};
const fixture = records.map(({ id, ...fields }) => ({ model: 'occurrences.occurrence', pk: id, fields }));
const directory = fileURLToPath(new URL('../occurrences/fixtures/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const [name, data] of [['obis.json', fixture], ['obis-source.json', source]]) {
  await writeFile(`${directory}${name}.tmp`, `${JSON.stringify(data)}\n`);
  await rename(`${directory}${name}.tmp`, `${directory}${name}`);
}
console.log(`Prepared ${records.length} records in ${directory}obis.json`);
