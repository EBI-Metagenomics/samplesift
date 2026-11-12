import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const required = [
  'package.json', 'README.md', 'LICENSE', 'COLLECTION_API.md', 'STYLING.md',
  'dist/THIRD_PARTY_NOTICES.txt',
  'examples/styling/react/SampleExplorer.jsx', 'examples/styling/django/explorer.html',
  'examples/styling/samplesift-theme.css',
  'examples/styling/react-vf/README.md', 'examples/styling/react-vf/EbiSampleExplorer.jsx',
  'examples/styling/react-vf/samplesift-vf.css',
  ...Object.values(pkg.exports).flatMap(entry => Object.values(entry).map(path => path.replace(/^\.\//, ''))),
];
const [archive] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}));
const files = new Set(archive.files.map(file => file.path));
const missing = required.filter(file => !files.has(file));
if (missing.length) throw new Error(`Files missing from npm archive: ${missing.join(', ')}`);
if (![...files].some(file => /^dist\/assets\/maplibre-gl-worker-.*\.js$/.test(file))) {
  throw new Error('The MapLibre worker is missing from the npm archive.');
}
if ([...files].some(file => /(^|\/)(node_modules|\.env|\.git|test-results|playwright-report)(\/|$)/.test(file))) {
  throw new Error('The npm archive contains development/private files. Check the package files allowlist.');
}
if (pkg.license !== 'Apache-2.0') throw new Error('Review the package license before publishing.');
console.log(`${pkg.name}@${pkg.version}: ${archive.entryCount} files, ${(archive.size / 1024 / 1024).toFixed(2)} MB packed. Exports, docs, examples, licenses and worker are present.`);
