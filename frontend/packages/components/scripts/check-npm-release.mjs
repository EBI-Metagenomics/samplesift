import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@microbiome-informatics/samplesift';
// npm releases use SemVer without build metadata, which npm can normalize away.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Validate the npm release independently of the Python package version. */
export function validateNpmRelease({ manifest, lockfile, tag, prerelease }) {
  if (manifest?.name !== PACKAGE_NAME || manifest.private === true) {
    throw new Error(`Release package must be the public ${PACKAGE_NAME} package.`);
  }
  const version = manifest.version;
  const match = typeof version === 'string' && version.length <= 256 && RELEASE_VERSION.exec(version);
  if (!match || match.slice(1, 4).some(value => !Number.isSafeInteger(Number(value)))
    || match[4]?.split('.').some(value => /^0\d+$/.test(value))) {
    throw new Error('Package version must be strict SemVer without build metadata or leading zeroes.');
  }
  const locked = lockfile?.packages?.['packages/components'];
  if (locked?.name !== PACKAGE_NAME || locked.version !== version) {
    throw new Error('The component name and version must match frontend/package-lock.json.');
  }
  if (tag !== `npm-v${version}`) {
    throw new Error(`npm release tag must be npm-v${version}.`);
  }
  if (typeof prerelease !== 'boolean' || prerelease !== Boolean(match[4])) {
    throw new Error('The GitHub prerelease flag must agree with the package SemVer prerelease suffix.');
  }
  return { version, distTag: prerelease ? 'next' : 'latest' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [manifest, lockfile] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    const releaseFlag = process.env.RELEASE_PRERELEASE;
    const result = validateNpmRelease({
      manifest,
      lockfile,
      tag: process.env.RELEASE_TAG,
      prerelease: releaseFlag === 'true' ? true : releaseFlag === 'false' ? false : undefined,
    });
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist_tag=${result.distTag}\n`);
    }
    console.log(`${PACKAGE_NAME}@${result.version} will use the ${result.distTag} dist-tag.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
