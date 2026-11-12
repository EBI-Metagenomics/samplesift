# Publishing the SampleSift component package

The npm package lives in `frontend/packages/components`, not the repository root.
Its proposed first release is `@samplesift/components@0.1.0`, under Apache-2.0.
The package license applies to the frontend component package; this does not
assign a license to the rest of the repository.

Nothing in the preparation commands below uploads a release. A registry lookup
on 12 November 2026 returned 404 for this package. That means it was not publicly
listed then; it does **not** establish ownership of the `@samplesift` scope.
Before publishing, confirm that the publishing account can publish under that
scope, or agree on another name and update the package, lockfile and examples.

## Validate locally

Use Node.js 22.12 or newer, then from `frontend/`:

```sh
npm ci
npm test
npm run lint
npm run build
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
npm run check:package --workspace @samplesift/components
```

Omit `PLAYWRIGHT_CHANNEL=chrome` if Playwright's Chromium is installed.

Create a local archive from `frontend/packages/components/`:

```sh
npm pack --dry-run
npm pack --pack-destination /tmp
```

`prepack` builds from the current sources and checks that the npm archive includes
both exported entry points, TypeScript declarations, the MapLibre worker,
collection/styling documentation, React/Django examples, and license notices.
`npm publish` also runs unit tests before that same build/pack check. Browser tests
and lint remain explicit release checks, because the browser/environment setup is
not part of an npm lifecycle script.

The build records license and notice text for bundled dependencies in
`dist/THIRD_PARTY_NOTICES.txt`. The two Terra Draw packages omit those files from
their npm archives, so exact-release copies and their sources are tracked under
`scripts/licenses/`. Review those copies when upgrading the dependencies.

## Test the archive as a consumer

In a separate Vite application, install the generated archive rather than a
workspace link:

```sh
npm install /tmp/samplesift-components-0.1.0.tgz
```

Import `@samplesift/components` in the browser entry point and render:

```html
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences"></sample-sift>
```

Run that application's production build and preview. Verify that the map's worker
loads successfully, filters can be added, and both package documentation examples
are present in `node_modules/@samplesift/components/examples/styling/`.
The component must be imported on the client in applications with server rendering.
The separate `@samplesift/components/data` entry can be imported without a browser
DOM. A same-origin proxy or suitable backend CORS configuration is needed for API
requests; package installation does not configure the host's API routing.

For a Django template without a JavaScript bundler, copy the **complete** `dist/`
directory to the application's static assets, preserving relative filenames, and
load `sample-sift.js` as a module. Keep chunks and worker assets with the entry point.
Use a static serving setup that preserves those URLs, or a bundler that rewrites
asset references; Django manifest hashing does not automatically rewrite arbitrary
JavaScript imports and worker URLs. See the packaged Django example.

## Publish when approved

After checking the intended npm account, scope permissions, version and release
contents, authenticate using npm's normal interactive flow. Do not add tokens to
this repository. From `frontend/packages/components/`, the publishing command is:

```sh
npm publish
```

`publishConfig` explicitly chooses the public npm registry and public access for
the scoped package. This command publishes the current version to `latest`; use
an agreed prerelease version and dist-tag instead if the release is intended as a
preview. Versions already published cannot be reused.

After publishing, confirm the version with `npm view @samplesift/components version`, then perform a fresh registry install in the consumer application.
The package's browser entry registers custom elements on import; `sideEffects`
remains enabled so bundlers retain that registration.

References: [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/),
[scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
