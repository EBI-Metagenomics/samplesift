# Publishing the SampleSift component package

The npm package lives in `frontend/packages/components`, not the repository root.
Its proposed first release is `@samplesift/components@0.1.0`, under Apache-2.0.
The package license applies to the frontend component package; this does not
assign a license to the rest of the repository.

The npm archive contains the browser component, TypeScript declarations, styling
examples and supporting assets. Consumers install it with npm and connect it to
an existing collection API; they do not need a checkout of this repository. The
Python API is a separate installation and deployment.

Nothing in the preparation commands below uploads a release. A registry lookup
on 12 November 2026 returned 404 for this package. That means it was not publicly
listed then; it does **not** establish ownership of the `@samplesift` scope.
Before publishing, confirm that the publishing account can publish under that
scope, or agree on another name and update the package, lockfile and examples.

## Shared versions and release tag

| Distribution | Version source | GitHub release tag | Publisher |
| --- | --- | --- | --- |
| PyPI `samplesift` | Root `pyproject.toml` | `v<version>` | `publish-python.yml` |
| npm `@samplesift/components` | Component `package.json` and frontend lockfile | `v<version>` | `publish-npm.yml` |

Both workflows listen for a **published GitHub release** whose tag starts with
`v`, so one release publishes both packages. Pushing a tag or saving a draft
release does not publish a package. Releases with other tags are skipped.
The versions move in lockstep: the tag must equal `v` followed by the
`pyproject.toml` version, and the component `package.json` and its lockfile entry
must have that same version. Each workflow checks both versions before running its
release checks, so a mismatch fails both publishers rather than shipping one package.

Only stable `X.Y.Z` versions are supported, which are valid both as SemVer and
PEP 440. The npm check rejects GitHub prereleases, prerelease suffixes, leading
zeroes and build metadata (`+...`). Every npm publication updates npm's `latest`
dist-tag, independently of GitHub's latest-release flag.

The Python distribution bundles the frontend built from its own release commit;
it does not download the npm package. Existing Python wheels are not updated;
each shared release publishes a new Python version with that release's UI.
Both builds include `build-info.json` beside the JavaScript, recording the frontend
package name, version, source revision and whether the checkout was dirty. Git
fields are null when the build has no Git metadata. This records what was bundled;
it does not negotiate API compatibility.

Choose the exact revision and version before producing the final archive.
`npm pack` includes the current working tree, including uncommitted files that
match its allowlist. Keep validation results with that archive and rebuild it
when included source or documentation changes.

The proposed frontend discovers the collection contract described in
[COLLECTION_API.md](../frontend/packages/components/COLLECTION_API.md#api-compatibility).
It requires advertised queryables, OpenAPI request/result schemas, read-only
HTTP `QUERY` endpoints and the documented MVT properties when tiles are enabled.
OpenAPI `info.version` currently says `1.0.0`; the component does not enforce that
as a compatibility version. Matching npm and Python versions proves nothing
about the API contract.

Repository `main` at `375aeee` includes the 512-pixel radius correction from
`552cdf5`, preserving proximity-based DBSCAN clustering. Record the actual backend
revision used for live consumer checks separately from the frontend revision;
a remote service or local tunnel need not be running the checkout under test.

## Publishing workflow

1. Validate the tag, package name/version, workspace lockfile, matching Python
   version and that the release is not a prerelease.
2. Call `test-frontend.yml` with `release_checks: true`: release-validator tests,
   TypeScript, unit tests, lint, browser tests, both asset builds and archive checks.
3. Build and check a fresh npm archive. Upload that single `.tgz` with its SHA-256
   checksum as the workflow artifact; this job has no publishing permission.
4. In the protected `npm` environment, download and verify that artifact, then
   publish it with OIDC Trusted Publishing. This job has no repository checkout
   or project dependency installation and uses `--ignore-scripts`, so it uploads
   the checked archive without rebuilding it.

The publishing runner uses Node.js 24 and npm 11.21.2. The reusable frontend
workflow keeps its ordinary PR checks, with lint also run by `lint.yml`; browser
and additional release lint checks are enabled by both publishing workflows.
The Python publisher additionally runs its Python/Django matrix and verifies its
wheel and source archive. See [python-release.md](python-release.md).

## One-time registry setup

- Confirm ownership or publishing access to `@samplesift`, and the intended
  public package name. npm and PyPI ownership are separate.
- Create the GitHub environment `npm`, add required reviewers and restrict
  deployment to tags matching `v*`.
- On the npm package, configure a GitHub Actions trusted publisher with owner
  `EBI-Metagenomics`, repository `samplesift`, workflow `publish-npm.yml` and
  environment `npm`. These values must match exactly. Enable **direct publishing**
  for this publisher; a staging-only publisher does not complete this workflow.

npm requires an existing package before its trusted publisher can be configured.
For the first release, an authorized npm maintainer therefore needs to publish
the approved archive using npm's interactive authentication, then configure the
trusted publisher for later versions. Do not add a long-lived token fallback to
this workflow or store tokens in the repository. A first manual publication must
not be followed by a published `v` GitHub release of the same version: that
would try to upload it again. Keep a Git tag if desired and use the workflow for
the next version.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm trust setup](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for registry
requirements. Configuring the environment and registry is separate from merging
these files; neither setup nor a publication is performed by local checks.

## Validate locally

Use Node.js 22.12 or newer, then from `frontend/`:

```sh
npm ci
node --test tests/check-npm-release.test.mjs
npm test
npm run lint
npm run build
npm run build:django
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
npm run check:package --workspace @samplesift/components
```

Omit `PLAYWRIGHT_CHANNEL=chrome` if Playwright's Chromium is installed. These
commands are release checks to run, not a claim that they passed for every
subsequent revision. Record failures or environment limits instead of carrying
forward results from an earlier build.

Create a fresh local archive from `frontend/packages/components/`:

```sh
release_artifacts="$(mktemp -d)"
npm pack --pack-destination "$release_artifacts"
```

Use the path printed by this command in the consumer checks below. A fresh
directory avoids confusing the new archive with an older archive of the same
version. `npm pack --dry-run` can be used to inspect the file list without writing
an archive; it still runs the package's preparation scripts.

`prepack` builds from the current sources and checks that the npm archive includes
both exported entry points, TypeScript declarations, the MapLibre worker,
collection/styling documentation, React/Django examples, and license notices.
The archive check also rejects development/private paths such as `.env`, `.git`,
`node_modules`, and test reports. This file check does not replace a consumer
production build or a browser check of the worker and API.

Publishing directly from the source directory runs its lifecycle scripts, but
the release workflow deliberately publishes a previously checked archive with
`--ignore-scripts`. The CI test job provides the unit, lint and browser gates.

The build records license and notice text for bundled dependencies in
`dist/THIRD_PARTY_NOTICES.txt`, and copies the frontend `LICENSE` alongside it.
The Django asset build preserves the same notices and build metadata. The two Terra Draw packages omit those files from
their npm archives, so exact-release copies and their sources are tracked under
`scripts/licenses/`. Review those copies when upgrading the dependencies.

## Test the archive as a consumer

Use a fresh application outside this workspace. Install the archive produced
above, replacing the path in this example with its actual location:

```sh
npm install /path/to/samplesift-components-0.1.0.tgz
```

Use the package's public entry point in the application's browser JavaScript:

```js
import '@samplesift/components';
```

Render the element with an API root that the consumer application can reach:

```html
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences"></sample-sift>
```

This starts in compact mode with filters closed and no table. Also verify
`show-table` for the optional Results panel and `layout="full" show-table` for
an expanded explorer. Do not import from this repository's `src/` or depend on
its Vite development proxy: the consumer must use only the installed package and
its own API routing configuration.

Run the consumer's production build and preview. Check that:

- The MapLibre worker and all module chunks load from the built application.
- Discovery, filter Apply, polygon selection, results and tile requests reach
  the intended API; filters apply equally to the table and map.
- Zooming requests higher-zoom tiles, with clustering interpreted according to
  the configured backend settings rather than an assumed split at every zoom.
- Compact panels, optional results and full layout work in the host's container.
- Styling variables and named parts work in the packaged React example, including
  its EBI Visual Framework variant when that stylesheet is installed by the host.
- The separate `@samplesift/components/data` entry imports without a browser DOM.

The component must be imported on the client in applications with server
rendering. A same-origin proxy or suitable backend CORS configuration is needed
for API requests; package installation does not configure the host's API routing.
The package does not provide custom collection authentication headers.

For React, use the files under
`node_modules/@samplesift/components/examples/styling/react/` or `react-vf/` in
the fresh consumer and follow their packaged guides. Opt into the table explicitly
when checking table styles. The package is framework-agnostic; React is a host
example, not a runtime requirement.

For a Django template without a JavaScript bundler, copy the **complete**
`node_modules/@samplesift/components/dist/` directory to the application's static
assets, preserving relative filenames, and load `sample-sift.js` as a module.
Keep chunks and worker assets with the entry point. Use a static serving setup
that preserves those URLs, or a bundler that rewrites asset references; Django
manifest hashing does not automatically rewrite arbitrary JavaScript imports and
worker URLs. Render the packaged Django example with the table both omitted and
explicitly enabled, and check its static assets in a browser.

## Cut a release only when approved

For an established package with Trusted Publishing configured:

1. Bump both versions together. From `frontend/`, run
   `npm version 0.2.0 --workspace @samplesift/components --no-git-tag-version`;
   from the repository root, run `uv version 0.2.0`. Commit the component
   manifest, workspace lockfile, `pyproject.toml` and `uv.lock` after the checks
   above pass.
2. Merge the approved changes, then publish a stable GitHub release tagged `v0.2.0`
   at that exact revision. This starts both the PyPI and npm publishers.
3. Review both workflows' checks and approve the `pypi` and `npm` deployment
   environments.

For the initial manual bootstrap described above, publish the **approved archive**,
not a newly built directory. With its actual path and the appropriate dist-tag:

```sh
npm publish /path/to/approved-package.tgz --ignore-scripts --access public --tag latest
```

That command uploads the package. Run it only with explicit release approval;
local build and pack checks do not authorize publication. Published versions
cannot be reused.

After publishing, confirm the exact version and dist-tags with `npm view`, then
perform a fresh registry install in the consumer application:

```sh
npm install @samplesift/components@0.1.0
```

Repeat the consumer production build and browser smoke check. The browser entry
registers custom elements on import; `sideEffects` remains enabled so bundlers
retain that registration.
