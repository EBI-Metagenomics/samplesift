import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateNpmRelease } from '../packages/components/scripts/check-npm-release.mjs';

const packageName = '@microbiome-informatics/samplesift';
function release(version = '0.1.0') {
  return {
    manifest: { name: packageName, version },
    lockfile: { packages: { 'packages/components': { name: packageName, version } } },
    tag: `v${version}`,
    prerelease: false,
    pythonVersion: version,
  };
}

test('stable shared release publishes to latest', () => {
  assert.deepEqual(validateNpmRelease(release('2.3.4')), { version: '2.3.4', distTag: 'latest' });
});

test('reject a Python version that differs from the npm version', () => {
  for (const pythonVersion of ['0.1.1', '0.1', '', undefined]) {
    assert.throws(() => validateNpmRelease({ ...release(), pythonVersion }), /versions must match/);
  }
});

test('npm-prefixed, bare, unrelated, missing and mismatched tags cannot publish', () => {
  for (const tag of ['npm-v0.1.0', '0.1.0', 'other-v0.1.0', 'v0.2.0', 'v0.1.0\n', undefined]) {
    assert.throws(() => validateNpmRelease({ ...release(), tag }), /release tag must/);
  }
});

test('reject prerelease, invalid or ambiguous versions before producing outputs', () => {
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta.1', '1.0.0-0',
    '1.2.3-', '1.2.3+build.1', '9007199254740992.0.0', '1.2.3\n']) {
    assert.throws(() => validateNpmRelease(release(version)), /stable X\.Y\.Z/);
  }
});

test('reject GitHub prereleases and malformed prerelease flags', () => {
  for (const prerelease of [true, 'false', 'true', undefined]) {
    assert.throws(() => validateNpmRelease({ ...release(), prerelease }), /prereleases are not supported/);
  }
});

test('reject a different or private package', () => {
  for (const manifest of [{ name: 'samplesift', version: '0.1.0' }, { ...release().manifest, private: true }]) {
    assert.throws(() => validateNpmRelease({ ...release(), manifest }), /public @microbiome-informatics\/samplesift/);
  }
});

test('reject a stale, renamed or missing workspace lock entry', () => {
  for (const locked of [{ name: packageName, version: '0.0.9' }, { name: 'other', version: '0.1.0' }, undefined]) {
    const lockfile = { packages: { 'packages/components': locked } };
    assert.throws(() => validateNpmRelease({ ...release(), lockfile }), /package-lock/);
  }
});

test('CLI checks the real package and writes bounded GitHub outputs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/components/package.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'samplesift-release-check-'));
  const output = join(directory, 'output');
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../packages/components/scripts/check-npm-release.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: { ...process.env, RELEASE_TAG: `v${manifest.version}`, RELEASE_PRERELEASE: 'false', PYTHON_VERSION: manifest.version, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), `version=${manifest.version}\ndist_tag=latest\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
