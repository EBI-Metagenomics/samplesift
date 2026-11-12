import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const files = await readdir(dist, { recursive: true });
const packages = new Set();

// The library and its worker bundle dependencies. Preserve each included package's
// license/notice text beside those bundles, using their source maps as the inventory.
for (const file of files.filter(name => name.endsWith('.js.map'))) {
  const map = JSON.parse(await readFile(join(dist, file), 'utf8'));
  for (const source of map.sources ?? []) {
    const path = resolve(dist, dirname(file), source);
    const marker = `${sep}node_modules${sep}`;
    const index = path.lastIndexOf(marker);
    if (index === -1) continue;
    const base = path.slice(0, index + marker.length);
    const segments = path.slice(index + marker.length).split(sep);
    packages.add(join(base, ...segments.slice(0, segments[0].startsWith('@') ? 2 : 1)));
  }
}
if (!packages.size) throw new Error('No bundled packages found. Build with source maps before preparing the npm archive.');

const entries = [];
for (const directory of packages) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const licenseFiles = (await readdir(directory)).filter(name => /^(licen[sc]e|notice)(\.[\w-]+)?$/i.test(name));
  const texts = await Promise.all(licenseFiles.sort().map(async name => `${name}\n\n${await readFile(join(directory, name), 'utf8')}`));
  if (!texts.length) {
    // These pinned npm archives omit their repository LICENSE. Exact-release copies
    // and their provenance are tracked in scripts/licenses/README.md.
    try {
      texts.push(await readFile(join(root, 'scripts/licenses', `${pkg.name}-${pkg.version}.txt`), 'utf8'));
    } catch {
      throw new Error(`Missing bundled license text for ${pkg.name}@${pkg.version}; review before packing.`);
    }
  }
  entries.push({ name: pkg.name, text: `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'see text below'}\n\n${texts.join('\n\n')}` });
}
entries.sort((left, right) => left.name.localeCompare(right.name));
await writeFile(join(dist, 'THIRD_PARTY_NOTICES.txt'), [
  'SampleSift includes the following third-party software. These notices apply to\nthose dependencies; SampleSift itself is licensed under Apache-2.0.\n',
  ...entries.map(entry => `\n${'='.repeat(72)}\n${entry.text}`),
].join('\n'));
console.log(`Preserved license notices for ${entries.length} bundled packages.`);
