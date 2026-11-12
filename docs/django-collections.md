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

Every row has a `source_pk` string primary key with a maximum length of 255 characters. Consequently, one collection
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
collection tables. For spatial collections it also installs the write-version table
and triggers used by the tile cache. When a cache is configured, it then prewarms
the cache with unfiltered tiles; pass `--no-warm-cache` to skip this (see
[Tile caching](tile-cache.md)). It reports missing, extra, type-incompatible, or
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

All tests use PostgreSQL with PostGIS. Start the local service and run the full
suite with:

```shell
docker compose up -d postgis
uv run pytest
```

Run either group separately with:

```shell
uv run pytest tests --ignore=tests/integration
uv run pytest tests/integration
```

The test settings default to the Docker service at `127.0.0.1:55432`, with
database, user, and password `samplesift`. Override these using `POSTGRES_HOST`,
`POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`.
Django creates separate test databases for the `default` and `samplesift`
aliases; the configured user needs permission to create and drop databases and
enable PostGIS. The local Python environment also needs the GDAL and GEOS
libraries required by GeoDjango. `tests.postgis_settings` remains available as
an alias for the shared test settings. If Django cannot discover those libraries,
set `GDAL_LIBRARY_PATH` and `GEOS_LIBRARY_PATH` to their installed paths.

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
- `QUERY /samplesift/collections/{api_name}/tiles/{z}/{x}/{y}` returns a Mapbox Vector Tile.
  By default, through zoom 14 it groups filtered points by proximity in Web Mercator using
  PostGIS DBSCAN with a 40-pixel distance and a minimum of one point. Connected
  chains of nearby points form one cluster, so a cluster can span more than 40
  pixels. Pixels are screen pixels of MapLibre's default 512-pixel vector tiles.
  Clustering considers the entire filtered collection before selecting
  cluster centroids for a tile, ensuring adjacent tiles agree on membership. This
  can be expensive for large collections. By default, at zoom 15 and above it returns
  individual points. Cluster IDs depend on membership and are not permanent.
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

Spatial collections also expose `geometry` with the `s_intersects` operator. Its
right operand is a GeoJSON Polygon or MultiPolygon in EPSG:4326, with longitude
and latitude coordinates. Polygon holes are supported, and points on any boundary
match. Invalid, empty, or out-of-range geometries are rejected. Null geometries
are unknown under this predicate, including under `not`.

```json
{"filter": {"op": "s_intersects", "args": [
  {"property": "geometry"},
  {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
]}}
```

This filter applies to both results and tiles, before tile clustering. The existing
filter complexity limit also applies to polygon coordinates.

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

The interactive documentation displays the returned tile on a map above the raw
response, using the same request and preserving its response. MapLibre is loaded
from jsDelivr and the basemap from OpenStreetMap, so rendering requires access to
those services. The map shows the returned tile with an orange boundary at one
zoom level farther out; its features are decoded in the browser for display.
The preview appears for any `QUERY` response with content type
`application/vnd.mapbox-vector-tile`, taking the tile coordinates from the
operation's `{z}`, `{x}` and `{y}` path parameters, so it does not depend on the
URL shape.
Swagger UI's internal schema is adapted to display `QUERY`
operations; requests still use `QUERY` and the published OpenAPI schema remains
unchanged. Generated curl commands and their copy button also use `QUERY`.

Spatial collection indexes use Django's PostgreSQL `GistIndex`; creating and
registering a spatial collection therefore requires Django's PostgreSQL support
and its database driver as well as the PostGIS database. Add
`django.contrib.postgres` to `INSTALLED_APPS` for spatial collections.

## Embedding the explorer

The `samplesift` template tag renders the `<sample-sift>` collection explorer for a
registered spatial collection. The host project needs `django.contrib.staticfiles`
and `STATIC_URL`, and must include `api.urls` in its URL configuration.

```django
{% load samplesift %}
{% samplesift "occurrences" %}
{% samplesift "occurrences" page_size=25 filter_mode="manual" id="left" class="explorer" %}
```

| Argument | Default | Meaning |
| --- | --- | --- |
| collection | required | The collection's `api_name`; an unknown name raises `KeyError`. |
| `page_size` | `SAMPLESIFT_DEFAULT_PAGE_SIZE` | Results per page, capped at `SAMPLESIFT_MAX_PAGE_SIZE`. |
| `filter_mode` | component default (`auto`) | `auto` applies filters as they change; `manual` adds an Apply step. |
| `filter_debounce_ms` | component default (500) | Delay before automatic filters apply. |
| `api_url` | reversed API root | Override when the API is served from another host. |
| `id`, `class` | none | Copied onto the element. |

The tile layer is the collection's `api_name`. The module script is emitted once per
template render. The built components are not committed: run
`npm run build:django --prefix frontend` before building the Python package; it writes
them to `src/samplesift/django/static/samplesift/components/`.

## API settings

SampleSift validates these global Django settings at startup. Configure them before
starting the application; restart after changing them. Defaults preserve the
standard API behavior.

| Setting | Default | Constraint |
| --- | ---: | --- |
| `SAMPLESIFT_FILTER_MAX_DEPTH` | 20 | Non-negative integer |
| `SAMPLESIFT_FILTER_MAX_NODES` | 500 | Positive integer |
| `SAMPLESIFT_DEFAULT_PAGE_SIZE` | 100 | Positive integer, no greater than the maximum page size |
| `SAMPLESIFT_MAX_PAGE_SIZE` | 500 | Positive integer |
| `SAMPLESIFT_CLUSTER_RADIUS_PIXELS` | 40 | Positive integer |
| `SAMPLESIFT_CLUSTER_MAX_ZOOM` | 14 | Non-negative integer |
| `SAMPLESIFT_CACHE_ALIAS` | `default` when explicitly configured | Name of a configured Django cache |
| `SAMPLESIFT_CACHE_TIMEOUT` | 3600 | Positive integer, in seconds |

Filter depth starts at zero; the node limit counts all objects, arrays, and
scalar values in the expression. The clustering radius is measured in pixels;
clustering applies through the configured maximum zoom, inclusive. Increasing
filter or page limits can increase resource use.

Vector tiles are cached only when the application explicitly configures Django's
`CACHES` setting, or selects a cache with `SAMPLESIFT_CACHE_ALIAS`. The cache
includes both clustered and individual-point tiles. A tile cached at request time
expires `SAMPLESIFT_CACHE_TIMEOUT` seconds after it is stored and is then recomputed
on its next request. Use a shared cache backend when running multiple workers,
since local-memory caches are per process.

Cache keys contain the collection's version: the time of the last write to its
table, which a database trigger records. Any write changes the version and makes
earlier tiles unreachable, including `QuerySet.update()`, raw SQL, and bulk loads.
`samplesift_sync_schema` installs the trigger. Until it has run, tiles are not
cached. Cache entries are bypassed while the collection database connection is
inside a transaction.

`samplesift_sync_schema` also prewarms the clustered zooms (0 to
`SAMPLESIFT_CLUSTER_MAX_ZOOM`) for the unfiltered query. Prewarmed tiles never expire,
so configure the cache backend to evict entries when it is full. Run the command
again after loading data to warm the new version.
[Tile caching](tile-cache.md) explains the keys, invalidation, and prewarming in
detail.

The [OBIS example](../examples/obis/README.md#tile-caching) configures Django's
Redis cache in Docker Compose and shows how to inspect cached tile keys.
