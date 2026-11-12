import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@samplesift/components';
// Shared releases are stable X.Y.Z, which is valid as both SemVer and PEP 440.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Validate the npm side of a shared v<version> release for Python and npm. */
export function validateNpmRelease({ manifest, lockfile, tag, prerelease, pythonVersion }) {
  if (manifest?.name !== PACKAGE_NAME || manifest.private === true) {
    throw new Error(`Release package must be the public ${PACKAGE_NAME} package.`);
  }
  const version = manifest.version;
  const match = typeof version === 'string' && version.length <= 256 && RELEASE_VERSION.exec(version);
  if (!match || match.slice(1, 4).some(value => !Number.isSafeInteger(Number(value)))) {
    throw new Error('Package version must be a stable X.Y.Z version without leading zeroes.');
  }
  const locked = lockfile?.packages?.['packages/components'];
  if (locked?.name !== PACKAGE_NAME || locked.version !== version) {
    throw new Error('The component name and version must match frontend/package-lock.json.');
  }
  if (pythonVersion !== version) {
    throw new Error('Python and npm versions must match for a shared release.');
  }
  if (tag !== `v${version}`) {
    throw new Error(`release tag must be v${version}.`);
  }
  if (prerelease !== false) {
    throw new Error('GitHub prereleases are not supported; publish a stable release.');
  }
  return { version, distTag: 'latest' };
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
      pythonVersion: process.env.PYTHON_VERSION,
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
