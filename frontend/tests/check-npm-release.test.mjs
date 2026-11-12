import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateNpmRelease } from '../packages/components/scripts/check-npm-release.mjs';

const packageName = '@samplesift/components';
function release(version = '0.1.0') {
  return {
    manifest: { name: packageName, version },
    lockfile: { packages: { 'packages/components': { name: packageName, version } } },
    tag: `npm-v${version}`,
    prerelease: version.includes('-'),
  };
}

test('npm stable release is independent of the Python version', () => {
  const input = release('2.3.4');
  input.pythonVersion = '0.1.0';
  assert.deepEqual(validateNpmRelease(input), { version: '2.3.4', distTag: 'latest' });
});

test('SemVer prereleases go only to next', () => {
  for (const version of ['0.2.0-beta.1', '1.0.0-0', '1.0.0-rc.01a']) {
    assert.deepEqual(validateNpmRelease(release(version)), { version, distTag: 'next' });
  }
});

test('Python, bare, unrelated, missing and mismatched tags cannot publish npm', () => {
  for (const tag of ['v0.1.0', '0.1.0', 'other-v0.1.0', 'npm-v0.2.0', 'npm-v0.1.0\n', undefined]) {
    assert.throws(() => validateNpmRelease({ ...release(), tag }), /npm release tag must/);
  }
});

test('reject invalid or ambiguous npm versions before producing outputs', () => {
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-rc.01',
    '1.2.3-', '1.2.3-rc..1', '1.2.3-rc_1', '1.2.3+build.1', '9007199254740992.0.0', '1.2.3\n']) {
    assert.throws(() => validateNpmRelease(release(version)), /strict SemVer/);
  }
});

test('reject both directions of a GitHub prerelease flag mismatch', () => {
  assert.throws(() => validateNpmRelease({ ...release(), prerelease: true }), /prerelease flag/);
  assert.throws(() => validateNpmRelease({ ...release('1.0.0-rc.1'), prerelease: false }), /prerelease flag/);
  for (const prerelease of ['false', 'true', undefined]) {
    assert.throws(() => validateNpmRelease({ ...release(), prerelease }), /prerelease flag/);
  }
});

test('reject a different or private package', () => {
  for (const manifest of [{ name: 'samplesift', version: '0.1.0' }, { ...release().manifest, private: true }]) {
    assert.throws(() => validateNpmRelease({ ...release(), manifest }), /public @samplesift\/components/);
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
    const prerelease = manifest.version.includes('-');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../packages/components/scripts/check-npm-release.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: { ...process.env, RELEASE_TAG: `npm-v${manifest.version}`, RELEASE_PRERELEASE: String(prerelease), GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), `version=${manifest.version}\ndist_tag=${prerelease ? 'next' : 'latest'}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
