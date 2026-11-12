# Publishing the SampleSift Python package

`.github/workflows/publish-python.yml` publishes `samplesift` to PyPI when a
GitHub release is published. It uses
[Trusted Publishing](https://docs.pypi.org/trusted-publishers/): PyPI accepts a
short-lived OIDC token from the workflow, so no API token is stored in the
repository or its secrets.

## Pipeline

1. `test-python` calls `test-python.yml` with `workflow_call`, so its path filters
   don't apply and the full Django/PostGIS matrix, Jupyter wrapper and wheel
   build/import checks always run. The frontend and example workflows are not
   gates.
2. `build` checks that the release tag, without a leading `v`, equals the
   `version` in `pyproject.toml`, runs `uv build` and uploads `dist/` as an
   artifact.
3. `publish` runs in the `pypi` deployment environment with `id-token: write`.
   It downloads the artifact and runs `pypa/gh-action-pypi-publish`, which also
   uploads attestations for the distributions. It does not check out the
   repository, so the job holding the token runs no repository code.

The wheel needs no frontend build: `widget.js` and `tile-preview.js` are
committed under `src/samplesift/`.

## One-time setup

- GitHub: Settings → Environments → create `pypi`. Add required reviewers to
  approve each upload, and restrict deployment to tags matching `v*`.
- PyPI: add a trusted publisher (a pending publisher before the first release)
  with owner `EBI-Metagenomics`, repository `samplesift`, workflow
  `publish-python.yml` and environment `pypi`.

The workflow, environment and repository names must match the PyPI settings
exactly. Renaming the workflow file requires updating the publisher on PyPI.

## Cutting a release

1. Bump `version` in `pyproject.toml`, run `uv lock`, and merge the change.
2. Create a GitHub release from `main` with tag `vX.Y.Z` matching that version.
3. Approve the `pypi` deployment if reviewers are required.

PyPI does not allow re-uploading a version. If the run fails after a successful
upload, bump the version rather than reusing the tag.
