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
