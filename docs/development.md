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
reusable workflows, with these path filters on pull requests:

| Workflow | Runs on changes to | Checks |
| --- | --- | --- |
| `test-python.yml` | `src/`, `tests/`, `pyproject.toml`, `uv.lock` | Django/PostGIS suite on Django 5.2 and 6.0 with Python 3.12 and 3.14, plus Django 5.0 on Python 3.12, Jupyter wrapper, wheel build and import |
| `test-frontend.yml` | `frontend/` | Release-tag validator tests, TypeScript, unit tests, component and Django static builds, package contents, `npm pack --dry-run` |
| `test-examples.yml` | `examples/` | OBIS fixture contents and provenance |

Each workflow also triggers on changes to its own file. In the merge queue,
path filters do not apply, so all three run. A caller can run a reusable workflow
with `workflow_call` regardless of its pull-request path filters.

`test-frontend.yml` accepts the boolean `release_checks` input, defaulting to
`false`. When enabled, it also runs frontend lint and installs Chromium to run
the Playwright browser suite:

```yaml
jobs:
  test-frontend:
    uses: ./.github/workflows/test-frontend.yml
    with:
      release_checks: true
```

Both publishing workflows enable these frontend release checks. The Python
publisher additionally runs the full Python workflow because its distribution
contains the API and bundled UI. Ordinary frontend pull requests and merge-queue
runs keep the default browser setting; run `task frontend:test:browser` locally
when checking browser changes.

## Release gates and versioning

Python and npm are independently versioned. Python releases use `v<version>`
from `pyproject.toml`; npm releases use `npm-v<version>` from the component
`package.json`, which must match its workspace lockfile entry. Each publishing
job is guarded by its own prefix. Unrelated releases skip it, and exact version
validation runs before the test gates. npm also requires the GitHub prerelease
flag to agree with its SemVer suffix, publishing stable versions to `latest` and
prereleases to `next`.

The Python pipeline builds Django static assets from the checked-out frontend
source before `uv build`; it does not fetch a published npm package. Its artifact
checker validates the wheel and source distribution before publishing. The
bundled `build-info.json` records the frontend package name/version and source
revision/dirty state. An npm release does not replace assets in an existing
Python wheel; that requires a new Python release.

The npm pipeline builds one archive and uploads it with a checksum. A separate
publishing job verifies and publishes that exact archive, with lifecycle scripts
disabled. Publishing permissions are confined to the final jobs and their
separate `pypi` and `npm` environments. Configure the environment protection and
registry trust as described in the [Python](python-release.md) and
[npm](frontend-release.md) release guides; a workflow file alone does not set up
those account permissions.

## Test environments and limits

The Django job uses a `postgis/postgis:16-3.4` service container on port 55432
with the `samplesift` credentials, matching `docker-compose.yml`. It installs
GDAL and GEOS on the runner with apt, because GeoDjango loads those libraries
in the test process. `uv.lock` pins a single Django release, so each matrix job
overlays its Django version with `uv run --with "Django==<version>.*"`.
`test_jupyter.py` also reads example data, so a change under `examples/` alone
does not rerun it on pull requests.

The workflows do not start the OBIS example. Run `task backend:up` for local
end-to-end checks against that API; browser tests use their configured fixtures.
A path-filtered workflow that is skipped reports no status, so do not make these
workflows required checks in branch protection without adding an always-run gate.
