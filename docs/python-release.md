# Publishing the SampleSift Python package

`.github/workflows/publish-python.yml` publishes `samplesift` to PyPI for a
published GitHub release whose tag is exactly `v` followed by the version in
`pyproject.toml`. It uses
[Trusted Publishing](https://docs.pypi.org/trusted-publishers/): PyPI accepts a
short-lived OIDC token from the workflow, so no API token is stored in the
repository or its secrets.

## Independent Python and npm releases

| Distribution | Version source | GitHub release tag |
| --- | --- | --- |
| Python `samplesift` | `pyproject.toml`, with `uv.lock` updated | `vX.Y.Z` |
| npm `@microbiome-informatics/samplesift` | `frontend/packages/components/package.json`, matching `frontend/package-lock.json` | `npm-vX.Y.Z` |

The versions do not need to match. Every job in each publisher checks its tag
prefix, so an npm release skips the Python pipeline and a Python release skips
the npm pipeline. Bare version tags do not publish either package. A matching
prefix with the wrong package version fails validation before tests or builds.
See [the npm release guide](frontend-release.md) for npm prereleases and channels.

The npm scope is `microbiome-informatics`; the GitHub repository remains
`EBI-Metagenomics/samplesift`. Use `EBI-Metagenomics` as the GitHub owner in
trusted publisher settings for both registries.

The Python distribution includes the Django API and browser assets for its Django
integration. These assets are built from the frontend source in the Python
release's checkout, without downloading the component from the npm registry.
A Python release therefore does not require an npm release first.

The bundle's `build-info.json` records its frontend package name and version,
source revision and whether the checkout was dirty when built. It is included
under `samplesift/django/static/samplesift/components/`, alongside the component
`LICENSE` and dependency notices. This identifies which UI a Python distribution
contains without requiring its Python and npm versions to be equal. The
component license does not assign a license to the Python code.

Publishing a newer npm version does not update an existing Python wheel. To
redistribute updated browser assets through Python, build and publish a new
Python version from the intended frontend source. Hosts using npm separately
should check the [collection API contract](../frontend/packages/components/COLLECTION_API.md#api-compatibility)
rather than assume matching version numbers prove compatibility.

## Pipeline

1. `validate-release` checks the exact `v<python-version>` tag. It does not strip
   a prefix and accept bare versions.
2. `test-python` calls `test-python.yml`, running the Django/PostGIS matrix,
   Jupyter wrapper and wheel build/import checks. `test-frontend` separately
   calls `test-frontend.yml` with `release_checks: true`, adding frontend lint and
   Playwright browser tests to its type, unit, build and archive checks. Both
   gates must pass. The example workflow is not a publishing gate.
3. `build` installs the locked frontend dependencies, runs `npm run build:django`
   and then `uv build`. The Python artifact checker verifies both the wheel and
   source distribution before they are uploaded: component assets and their
   worker, Django template, build information, license and dependency notices
   must be present, and the bundled static assets must agree byte-for-byte.
4. `publish` runs in the `pypi` deployment environment with `id-token: write`.
   It downloads the checked distributions and runs `pypa/gh-action-pypi-publish`,
   which also uploads attestations. It does not check out or execute repository
   code in the job holding the publishing permission.

`uv build` alone does not regenerate the component bundle. For a local artifact
check, run from the repository root:

```sh
npm ci --prefix frontend
npm run build:django --prefix frontend
uv build
python scripts/check-python-package.py dist
```

These commands prepare and validate files locally; they do not publish them.
The full release gates also run the tests described in
[development checks](development.md#continuous-integration).

## One-time setup

- GitHub: Settings → Environments → create `pypi`. Add required reviewers to
  approve each upload, and restrict deployment to tags matching `v*`.
- PyPI: add a trusted publisher (a pending publisher before the first release)
  with owner `EBI-Metagenomics`, repository `samplesift`, workflow
  `publish-python.yml` and environment `pypi`.

The workflow, environment and repository names must match the PyPI settings
exactly. Renaming the workflow file requires updating the publisher on PyPI.

## Cutting a release

1. Choose the backend and bundled frontend changes to include. Bump only the
   affected package versions; a Python-only change does not require an npm bump.
2. Bump `version` in `pyproject.toml`, run `uv lock`, and merge the approved change.
3. Create a GitHub release from the intended revision on `main` with the exact
   tag `v<python-version>`. Publishing that GitHub release starts the pipeline.
4. Review the checks and approve the `pypi` deployment if reviewers are required.

PyPI does not allow re-uploading a version. If the run fails after a successful
upload, bump the version rather than reusing the tag.
