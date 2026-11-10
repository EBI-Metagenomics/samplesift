# Spatial Collection Architecture

## Purpose

Build a Django application that exposes a declarative, Elasticsearch-document-like
query contract for source models, while materialising searchable data in a central
PostgreSQL database with PostGIS.

The source data may live in MySQL, DuckDB, PostgreSQL, or another supported Django
database. PostgreSQL/PostGIS is the derived query store, not the source of truth.

```text
Source database (Django model)
        |
        | materialise and synchronise
        v
PostgreSQL + PostGIS collection
        |
        | spatial queries, filters, sort, facets
        v
Application results
```

## What to take from django-elasticsearch-dsl

`django-elasticsearch-dsl` defines a `Document` for a Django model and registers it
in a central registry. The document declares the indexed representation, turns a
model instance into a serialisable payload, and is updated when source-model signals
fire. Rebuild commands populate the whole index in batches.

The useful equivalent here is:

- a registered document/collection definition for each source model;
- a declarative schema for materialised fields;
- generated physical schema and indexes in the PostGIS database;
- an asynchronous, idempotent collection pipeline;
- a constrained, composable query API.

Unlike Elasticsearch, the target is relational. Query execution should use Django
querysets, PostgreSQL aggregates, and PostGIS functions rather than an Elasticsearch
JSON query DSL.

## Document declaration

The public declaration should distinguish identity, collection fields, and the
operations a client is permitted to perform:

```python
@registry.register_document
class ListingDocument(SpatialDocument):
    class Source:
        model = Listing

    class Query:
        id = fields.IDField(attr="pk")
        geometry = fields.PointField(attr="location", srid=4326)

        status = fields.KeywordField()
        price = fields.DecimalField()
        created_at = fields.DateTimeField()

        category = fields.KeywordField(facet=True)
        bedrooms = fields.IntegerField(facet=True)
        neighbourhood = fields.KeywordField(
            attr="address__neighbourhood",
            facet=True,
        )

        title = fields.TextField(store=True)
```

Suggested field capabilities:

| Capability | Meaning |
|---|---|
| `store=True` | Persist the value in the collection. |
| `filterable=True` | Allow equality, inclusion, range, or other appropriate filters. |
| `facet=True` | Allow grouped bucket counts; normally also implies filterability. |
| `sortable=True` | Allow ordering. |
| `spatial=True` | Allow spatial predicates and distance ordering. |
| `searchable=True` | Allow full-text search if the product supports it. |

The registry compiles these declarations into a field catalog. The query API must
only accept fields and operations permitted by that catalog. This is both a stable
cross-database interface and a protection against querying private or expensive
source attributes.

## Collection storage

Each collection row needs a stable identity that does not depend on a PostgreSQL
primary key:

```python
class ListingCollection(models.Model):
    source_database = models.CharField(max_length=64)
    source_model = models.CharField(max_length=255)
    source_pk = models.CharField(max_length=255)

    geometry = gis_models.PointField(srid=4326, null=True)
    payload = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["source_database", "source_model", "source_pk"],
                name="unique_source_object",
            )
        ]
```

The example omits typed columns for brevity. Every declared queryable field should
normally have a real, appropriately typed Postgres column. This enables suitable
B-tree indexes, correct operators, constraints, efficient grouping, and predictable
query plans. A JSON payload is useful for opaque or display-only data, but should
not be the primary filter/facet mechanism.

Add a GiST or SP-GiST index for geometries, plus conventional indexes for common
filters and orderings. The generated schema can be managed through Django migrations
or explicit collection-table migration helpers.

## Synchronisation

The desired update path mirrors document indexing:

```text
source object is committed
  -> enqueue (document, source database, source PK, source version)
  -> worker reloads the source object
  -> document prepares typed collection values
  -> UPSERT target PostGIS row
```

Requirements:

- Queue work through `transaction.on_commit()` so rolled-back data is never
  materialised.
- Make jobs idempotent: duplicate delivery must be safe.
- Reload by primary key in the worker rather than queueing a full serialised
  collection.
- Store `source_updated_at` or a monotonically increasing source version. Reject an
  older collection job if a newer one has already been applied.
- Delete using the stable source identity.
- Provide full rebuild/reconciliation commands that iterate source records in
  batches and upsert them into the collection.

Django signals are appropriate for ordinary ORM writes, but they do not observe
`QuerySet.update()`, raw SQL, database imports, or outside writers. If any of those
are in scope, provide scheduled reconciliation at minimum; use a transactional
outbox or change-data capture for stronger guarantees.

## Related-model changes

Collection fields may denormalise values from related models. A change to a related
row must refresh all root objects whose collection contains that value.

```python
class ListingDocument(SpatialDocument):
    class Source:
        model = Listing
        related_models = [Category]

    def get_instances_from_related(self, related_instance):
        if isinstance(related_instance, Category):
            return related_instance.listings.all()
```

This is the relational equivalent of reindexing every Elasticsearch document that
embedded the changed value. It should be explicit in the document contract and
resolved asynchronously, especially for high-cardinality relationships.

## Query and facet execution

### Implemented HTTP query surface

The public query surface provides collection-specific queryables discovery and
`QUERY /collections/{api_name}/tiles/{z}/{x}/{y}` for clustered MVT and
`QUERY /collections/{api_name}/results` for paginated rows. Bodies accept the
documented CQL2 JSON subset. A backend-independent descriptor exposes materialized
scalar fields by default, with public-name and capability overrides. The registry
generates OpenAPI 3.2.1 operations and components for each collection. See
[Django collections](django-collections.md) for the implemented contract.

Geometry is declared as a WGS84 point copied from a source point or constructed
from longitude/latitude. The result endpoint deliberately returns individual
rows without a spatial bound, while the tile endpoint applies fixed screen-space clustering through a
documented maximum zoom. Map clients must use a custom `QUERY` tile adapter,
because stock tile URL sources issue `GET` requests only.

A public query builder can remain document-oriented:

```python
result = (
    ListingDocument.search()
    .within_radius(point, km=5)
    .filter(status="active", price__lte=500_000)
    .facet("category", "bedrooms")
    .order_by("price")
    .execute()
)
```

Internally, it compiles to a target PostGIS queryset:

```python
qs = (
    ListingCollection.objects
    .filter(geometry__dwithin=(point, 5_000))
    .filter(status="active", price__lte=500_000)
    .annotate(distance=Distance("geometry", point))
    .order_by("distance")
)

category_facet = (
    qs.values("category")
      .annotate(count=Count("source_pk", distinct=True))
      .order_by("-count", "category")
)
```

Faceting means grouping the current result set by a declared field or expression and
counting distinct root objects. A facet definition should support field paths,
expressions, display/value serialisation, and `distinct=True` for relationships that
may create duplicate rows.

Specify facet semantics explicitly:

- **Full-query/conjunctive:** Every selected filter affects every facet's buckets.
- **Self-excluding/disjunctive:** A facet omits its own selected filters when
  computing its buckets. This is typical for exploratory/e-commerce interfaces.

For self-excluding behaviour, retain immutable query state and build each facet from
a clone with only that facet's filters removed.

## Architectural boundaries

| Component | Responsibility |
|---|---|
| Source model/database | Authoritative business data. |
| Document declaration | Collection schema and permitted query capabilities. |
| Registry | Finds documents, field catalogs, and reverse dependencies. |
| Sync pipeline | Reliable propagation and rebuild/reconciliation. |
| PostGIS collection | Disposable, optimised derived query data. |
| Query builder | Validates the document contract and compiles Postgres/PostGIS queries. |

The collection database must be rebuildable from source data. It is an index, not a
second system of record.
