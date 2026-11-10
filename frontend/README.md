# Frontend workspace (reserved)

This directory intentionally has no Node tooling yet. It is reserved for a
self-contained npm workspace, expected to use this shape when frontend work
begins:

```text
frontend/
  package.json
  packages/
    components/  # @samplesift/components
```

The frontend and Python package have independent versions and release cycles.
