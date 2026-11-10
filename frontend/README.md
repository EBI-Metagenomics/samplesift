# SampleSift frontend

A self-contained npm workspace for reusable browser components. The frontend
and Python package have independent versions and release cycles.

```text
frontend/
  package.json             Private npm workspace
  package-lock.json        Shared dependency lockfile
  packages/
    components/            @samplesift/components: Lit + MapLibre + Terra Draw
```

## Develop

Use Node.js 22.12 or newer (CI uses Node.js 24). From the repository root:

```sh
cd frontend
npm ci
npm run dev
```

The demo uses explicitly labelled synthetic samples. A matching backend or
custom data adapter is required for real MGnify data. The component package's
[README](packages/components/README.md) documents the public interface,
proposed HTTP contract, map-only element and standalone HTML embedding.

## Check and build

Run these commands from `frontend/`:

```sh
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

If Chrome is installed, `PLAYWRIGHT_CHANNEL=chrome npm run test:browser` can use
it instead. The browser suite covers drawing, filtering, pagination, independent
instances, stale responses and reconnecting an element.

`npm run build` writes the distributable to `packages/components/dist/`.
`npm run preview` serves that build; open `/embed.html` for a plain HTML consumer.
Keep the emitted JavaScript chunks and worker assets together when deploying.
No project-level Node files or npm release coupling are added to the Python
package.
