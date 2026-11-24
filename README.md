# SampleSift

SampleSift provides spatial search for geolocated records.
Django collections store typed fields in derived PostgreSQL tables.
The Lit frontend displays filters, result tables, and clustered MapLibre tiles.
An optional Jupyter widget embeds the frontend in notebooks.

## Installation

Use Python 3.12 or newer.
Install the integration for your application:

```sh
pip install 'samplesift[django]'
# Or install the notebook wrapper:
pip install 'samplesift[jupyter]'
```

`pip install samplesift` installs the base package without optional integrations.
Spatial Django collections require PostGIS.
The Jupyter wrapper currently requires a running frontend server and collection API.

## Try the OBIS example

The repository includes a Django backend with 9,900 OBIS occurrence records.
The frontend uses that backend for filters, results, and map clusters.

Install Node.js 22.12 or newer, npm, Task, and Docker Compose 2.24.4 or newer.
From the repository root:

```sh
task frontend:setup
task dev
```

Open the Vite URL from the terminal.
API documentation is at <http://127.0.0.1:8002/samplesift/docs>.
Ctrl-C stops the development servers.
The database volume remains available.

See [development tasks](docs/frontend-development.md) for individual servers, ports, and checks.
See [the OBIS example](examples/obis/README.md) for dataset details and standalone Docker setup.

## Use SampleSift in Django

Declare collections in an installed app's `samplesift.py`:

```python
from samplesift.django import Point, SampleSiftCollection, registry

from .models import Sample


@registry.register
class SampleCollection(SampleSiftCollection):
    fields = ["lat", "lon", "temperature", "species_name"]
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = Sample
        api_name = "samples"

    class Query:
        default_ordering = ["-temperature"]
```

This example assumes those fields exist on your `Sample` model.
Django ORM saves and deletes synchronise collection rows after the source transaction commits.
Bulk updates, raw SQL, and related-object changes do not synchronise automatically.

Follow [Django collections](docs/django-collections.md) for app registration, database configuration, schema setup, and API routes.
Use [typed properties and resolvers](docs/django-collections.md#collection-schema) for computed or related fields.
Use [JSON metadata properties](docs/django-collections.md#json-metadata-properties) for values inside a JSONB field.
The [spatial query API](docs/django-collections.md#spatial-query-api) documents CQL2 filters, pagination, and vector tiles over HTTP `QUERY`.

## Use SampleSift in Jupyter

From a source checkout, install the notebook environment:

```sh
task jupyter:setup
```

Start the example backend, then open the notebook:

```sh
task backend:up
task jupyter:lab
```

The widget includes its frontend bundle. Vite is not required.

The [example notebook](examples/jupyter.ipynb) demonstrates filters, polygon searches, linked sliders, and DataFrame exports.
See [Jupyter setup and limits](docs/jupyter.md) for widget configuration and Python bindings.

## Documentation

| Topic | Guide |
| --- | --- |
| Django declarations, resolvers, API, and settings | [Django collections](docs/django-collections.md) |
| Cache configuration, invalidation, and prewarming | [Tile caching](docs/tile-cache.md) |
| Frontend setup and embedding | [Frontend guide](frontend/README.md) |
| Frontend state, events, and collection API | [Component API](frontend/packages/components/COLLECTION_API.md) |
| Frontend and backend development tasks | [Development tasks](docs/frontend-development.md) |
| Themes and styling | [Frontend styling](docs/frontend-styling.md) |
| Notebook setup and Python bindings | [Jupyter wrapper](docs/jupyter.md) |
| Python dependencies, Git hooks, and lint | [Development checks](docs/development.md) |
| Component package validation and publishing | [Frontend release guide](docs/frontend-release.md) |
| Longer-term design | [Spatial collection architecture](docs/spatial-collection-architecture.md) |

## Development

Install Python development dependencies and the Git hook:

```sh
uv sync --locked
task hooks:install
```

Use `task jupyter:setup` instead of `uv sync` for notebook development.
Run `task lint` for the pinned pre-commit checks.
Run `task frontend:check` for frontend lint, types, and unit tests.
See [development checks](docs/development.md) for hook setup details.
See [Django verification](docs/django-collections.md#verification) for PostGIS tests.

The Python package lives in `src/samplesift/`.
The npm workspace lives in `frontend/`.
Python and frontend packages have independent release cycles.
