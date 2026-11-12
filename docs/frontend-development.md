# Frontend development tasks

Use Node.js 22.12 or newer, npm, and Task.
The local backend also requires Docker Compose 2.24.4 or newer.
Run these commands from the repository root:

```sh
task frontend:setup
task dev
```

Open the Vite URL from the terminal.
`task dev` builds the OBIS backend from this checkout.
It waits for API readiness before starting Vite.
Initial setup imports 9,900 bundled OBIS records into PostGIS.
The API binds to `127.0.0.1:8002`.
API documentation is at `http://127.0.0.1:8002/samplesift/docs`.
Ctrl-C stops Vite and removes the backend containers.
The database volume remains available for later runs.

The backend uses the Compose project `samplesift-ui-dev`.
Stop any other service on port 8002 before startup.
For another local port:

```sh
SAMPLESIFT_BACKEND_PORT=8003 task dev
```

Python source changes trigger Django reloads through read-only bind mounts.
Dependency or Dockerfile changes require another backend build.
Source model changes can require migrations and collection reconciliation.

For separate terminals:

```sh
task backend:dev
task frontend:dev
```

For a background backend, use `task backend:up`.
Use `task backend:logs` for logs.
Use `task backend:down` for cleanup without database deletion.

The standalone frontend proxy defaults to `http://127.0.0.1:8002`.
For another backend origin:

```sh
SAMPLESIFT_API_TARGET=http://127.0.0.1:8001 task frontend:dev
```

The target must omit `/samplesift`.
For frontend work without a backend, open `/demo/legacy.html`.
That page uses synthetic data.

Pass command arguments after `--`:

```sh
task frontend:dev -- --port 5174 --strictPort
task frontend:test -- --watch
```

Available checks and build commands:

```sh
task frontend:check
task frontend:build
task frontend:preview
task frontend:browser:setup
task frontend:test:browser
```

`frontend:check` runs lint, TypeScript checks, and unit tests in sequence.
Individual tasks are `frontend:lint`, `frontend:typecheck`, and `frontend:test`.
The browser tests start their own Vite server on port 5173.
An installed Chrome can replace the downloaded Chromium:

```sh
PLAYWRIGHT_CHANNEL=chrome task frontend:test:browser
```

Run `task --list` for task descriptions.

## Proxy requests

Browser requests to `/samplesift` go to the Vite origin. Vite forwards them to
`SAMPLESIFT_API_TARGET`; seeing the frontend port in browser network tools is
expected. A 502 response can mean the API is unavailable or the proxy target is
wrong. Restart Vite after changing the target. Production hosts need their own
API proxy or suitable CORS configuration; this development proxy is not shipped
as an API server in the npm package.
