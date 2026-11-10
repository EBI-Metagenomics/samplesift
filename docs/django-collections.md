# Django collections

This document describes the currently implemented collection feature. It is a
small, synchronous foundation for the larger design in
[Spatial Collection Architecture](spatial-collection-architecture.md).

## Contract

A source model remains authoritative. A registered `SampleSiftCollection` declaration
creates a typed, derived table in the configured PostGIS database.

```python
# my_app/models.py
class Sample(models.Model):
    lat = models.FloatField()
    lon = models.FloatField()
    temperature = models.FloatField()
    species_name = models.CharField(max_length=255)
```

```python
# my_app/samplesift.py
from samplesift.django import Point, SampleSiftCollection, registry

from .models import Sample


@registry.register
class SampleCollection(SampleSiftCollection):
    fields = ["lat", "lon", "temperature", "species_name"]
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = Sample
        database = "default"  # optional; this is the default
        api_name = "samples"

    class Query:
        default_ordering = ["-temperature"]
```

Django automatically imports `samplesift.py` from installed applications when
`SamplesiftDjangoConfig` starts. Registration validates the declaration, creates
the runtime Django model, and connects source-model save/delete signals.

## Collection schema

Collection tables are managed at runtime, not by host application migrations.
Their names are `samplesift_<source_model_snake_case>_collection` (for example,
`samplesift_sample_collection`) and their Django app label is
`samplesift_django`. If source model names collide across applications, set a
unique lowercase `Meta.table_name` explicitly.

Every row has a `source_pk` string primary key. Consequently, one collection
must receive data from exactly one source database alias. A collection's source
alias comes from `Meta.database`; it defaults to `default`.

`fields` accepts source scalar fields and forward foreign keys:

- Scalar fields retain their Django field type. `auto_now` and `auto_now_add`
  behaviour is disabled in the collection so source timestamps are preserved.
- A foreign key is stored as the target object's raw primary-key value; no
  cross-database foreign-key constraint is created.
- Many-to-many fields, reverse relations, generated fields, duplicates, and
  `source_pk` are rejected.

Use `Property` for an aliased, related, or computed typed column:

```python
from django.db import models
from samplesift.django import Property, SampleSiftCollection


class SampleCollection(SampleSiftCollection):
    fields = ["species_name"]
    display_name = Property(
        models.CharField(max_length=255, null=True),
        attr="species__display_name",
    )
    temperature_band = Property(models.CharField(max_length=20))

    class Meta:
        model = Sample

    @staticmethod
    def prepare_temperature_band(sample):
        return "warm" if sample.temperature >= 20 else "cool"
```

`attr` uses Django-style `__` traversal and returns `None` if an intermediate
value is `None`. `prepare_<property_name>(source_instance)` takes precedence
over `attr`; a property must define one of them.

## Storage and schema setup

Collection storage uses `SAMPLESIFT_DATABASE_ALIAS`, defaulting to Django's
`default` database. The selected database must use PostgreSQL; SampleSift raises
a configuration error when a non-PostgreSQL backend is selected. Spatial
collections require `django.contrib.gis.db.backends.postgis` and PostGIS.
To retain an existing `samplesift` target, set
`SAMPLESIFT_DATABASE_ALIAS = "samplesift"` explicitly. Changing the target does
not move or populate existing collection tables.

For local development:

```shell
docker compose up -d postgis
```

Then configure the default database (or set `SAMPLESIFT_DATABASE_ALIAS` to a
separate configured database) and run:

```shell
python manage.py samplesift_sync_schema
```

The command enables the `postgis` extension and creates missing registered
collection tables. It reports missing, extra, type-incompatible, or
nullability-incompatible columns as schema drift, including point geometry subtype and SRID. It does not alter or drop
existing tables. The database user therefore needs permission to create the
PostGIS extension.

## Synchronisation semantics and limits

For normal Django ORM writes on the configured source alias:

1. `post_save` or `post_delete` schedules a callback using `transaction.on_commit()`.
2. A save callback reloads the source row and upserts its collection row.
3. A delete callback removes the row by `source_pk`.

The callback logs collection/source context and re-raises failures. A failed
collection write does not roll back the already committed source transaction.

This first version deliberately does not support:

- `QuerySet.update()`, raw SQL, imports, or external writers;
- queued/retried delivery, source versions, rebuilds, or reconciliation;
- refreshing root collections when a related object changes;
- facets.

When extending the feature, keep the target database disposable and derived;
do not add source-of-truth business state to collection tables.

## Verification

Run the fast suite with:

```shell
uv run pytest
```

The Docker-backed PostGIS integration test uses `tests.postgis_settings`:

```shell
docker compose up -d postgis
DJANGO_SETTINGS_MODULE=tests.postgis_settings uv run pytest tests/integration
```

## Spatial query API

Mount the ready-made Django Ninja API in the host project's URL configuration:

```python
from django.urls import path
from samplesift.django.api import api as samplesift_api

urlpatterns = [path("samplesift/", samplesift_api.urls)]
```

Every API collection declares a WGS84 `geometry` and `Query.default_ordering`.
Its API name defaults to the source model class name converted to lowercase
kebab case (`AirQualitySample` becomes `air-quality-sample`); set the optional
unique `Meta.api_name` to override it. `Point` accepts a source GeoDjango point field
(`Point(field="location")`) or numeric longitude and latitude attributes. The
generated table has a spatial GiST index; run `samplesift_sync_schema` after
adding it.

Each API collection has discovery and two static `QUERY` endpoints:

- `GET /samplesift/collections/{api_name}/queryables` returns a JSON Schema document
  describing public queryables and their supported operators.
- `QUERY /samplesift/collections/{api_name}/tiles/{z}/{x}/{y}` returns a Mapbox Vector Tile. It uses a
  fixed 40-pixel cluster grid through zoom 14, then returns individual points.
- `QUERY /samplesift/collections/{api_name}/results` returns individual rows selected only by the body
  filters, ordering, and pagination; it is independent of map bounds.

The optional `filter` body property is a CQL2 JSON expression, for example
`{"op": ">=", "args": [{"property": "temperature"}, 10]}`. Supported
operators are `and`, `or`, `not`, `=`, `<>`, `in`, and `isNull`; numeric and
temporal fields also support `<`, `<=`, `>`, and `>=`. Comparisons and `in`
take a property on the left and a typed literal or non-empty literal list on the
right. `isNull` takes one property. Null comparisons are unknown, including
under `not`; only true expressions match. CQL2 JSON is the only filter language.
The former URLs and `filters` array are no longer supported.

All materialized scalar fields are queryable by default. Override public names,
operators, and UI metadata on the collection declaration:

```python
class Query:
    default_ordering = ["-temperature"]
    queryables = {
        "temperature": {
            "name": "water_temperature",
            "operators": ["=", ">=", "<=", "isNull"],
            "annotations": {"unit": "°C", "control": "range", "order": 1},
        },
    }
```

Overrides use materialized field names as keys; public names are used in filters.
Sorting and returned fields retain materialized field names. The discovery schema
describes types and capabilities, not observed data ranges. This is a SampleSift
contract inspired by OGC, not a claim of OGC API conformance.

Results accept either
offset pagination (with `total`) or cursor pagination (with `next_cursor`).
`/samplesift/openapi.json` is generated from the startup registry as OpenAPI 3.2.1
and includes a separate operation and schemas for every collection. Collections may set `Query.query_example` to a valid request body for both query
operations, and `Query.tile_example` to a dictionary of `z`, `x`, and `y` values for the tile
operation’s path parameter examples. Register API
collections during Django startup; registrations after `api.urls` is accessed are
rejected and require a process restart. Stock
MapLibre/Leaflet tile sources issue only `GET`, so use a small custom source
adapter to fetch MVT bytes with `QUERY`.

Spatial collection indexes use Django's PostgreSQL `GistIndex`; creating and
registering a spatial collection therefore requires Django's PostgreSQL support
and its database driver as well as the PostGIS database. Add
`django.contrib.postgres` to `INSTALLED_APPS` for spatial collections.
