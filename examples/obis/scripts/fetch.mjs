import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// One named dataset; API order is a bounded subset, not a random sample.
const datasetId = 'ad65221f-0539-44aa-925e-4acf62ad0c6a';
const api = 'https://api.obis.org/v3';
const DEFAULT_RECORD_LIMIT = 10000;
const MAX_RECORD_LIMIT = 100000;
const PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60000;
const RETRY_INTERVAL_MS = 1000;
const MAX_LONGITUDE = 180;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;
const limit = Number(process.argv[2] ?? DEFAULT_RECORD_LIMIT);
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORD_LIMIT) {
  throw new Error(`Record limit must be an integer from 1 to ${MAX_RECORD_LIMIT}.`);
}
async function getJson(url) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`OBIS HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS * (attempt + 1)));
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
    size: String(Math.min(PAGE_SIZE, limit - inspected)),
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
    if (Math.abs(lon) > MAX_LONGITUDE || Math.abs(lat) > MAX_WEB_MERCATOR_LATITUDE || depth < 0) continue;
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
