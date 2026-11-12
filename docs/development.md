# Development checks

Install the development dependencies and Git hook from the repository root:

```sh
uv sync --locked
task hooks:install
```

For the Jupyter environment, use `task jupyter:setup` instead of `uv sync` where available.
Dependency installation alone does not install the Git hook.
The hook checks staged files before each commit.

Run all pinned checks before pushing:

```sh
task lint
```

Without Task:

```sh
uv run --locked pre-commit install
uv run --locked pre-commit run --all-files
```

The hook configuration pins Ruff 0.17.3 and Biome 2.5.13.
The first run downloads their hook environments and requires network access.

## Continuous integration

`lint.yml` runs Ruff and Biome on every pull request. Tests are split into three
reusable workflows. On pull requests and in the merge queue, each one runs only
when its paths change:

| Workflow | Runs on changes to | Checks |
| --- | --- | --- |
| `test-python.yml` | `src/`, `tests/`, `pyproject.toml`, `uv.lock` | Django/PostGIS suite on Django 5.2 and 6.0 with Python 3.12 and 3.14, plus Django 5.0 on Python 3.12, Jupyter wrapper, wheel build and import |
| `test-frontend.yml` | `frontend/` | TypeScript, unit tests, build, package contents, `npm pack --dry-run` |
| `test-examples.yml` | `examples/` | OBIS fixture contents and provenance |

Each workflow also triggers on changes to its own file. In the merge queue,
path filters don't apply, so all three run. Publishing workflows call them with
`workflow_call`, which ignores path filters, so the full set always runs:

```yaml
jobs:
  test-python:
    uses: ./.github/workflows/test-python.yml
  test-frontend:
    uses: ./.github/workflows/test-frontend.yml
```

The Django job uses a `postgis/postgis:16-3.4` service container on port 55432
with the `samplesift` credentials, matching `docker-compose.yml`. It installs
GDAL and GEOS on the runner with apt, because GeoDjango loads those libraries
in the test process. `uv.lock` pins a single Django release, so each matrix job
overlays its Django version with `uv run --with "Django==<version>.*"`.
`test_jupyter.py` also reads example data, so a change
under `examples/` alone does not rerun it on pull requests.

CI does not run the Playwright browser tests or start the OBIS example; run
them locally with `task frontend:test:browser` and `task backend:up`. A path-filtered workflow that is skipped reports
no status, so don't make these workflows required checks in branch protection
without adding an always-run gate.
