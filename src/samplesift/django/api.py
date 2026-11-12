"""The public, read-only API for registered SampleSift collections."""

from __future__ import annotations

import base64
import hashlib
import json
import math
from collections.abc import Iterator
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID

from django.db import connections, models
from django.db.models import Q, QuerySet
from django.http import HttpResponse
from django.urls import reverse
from django.utils.html import escape
from ninja import Body, NinjaAPI
from ninja.errors import HttpError
from ninja.openapi.docs import Swagger

from samplesift.query import Queryable

from .cache import VERSION_SQL, collection_version, tile_cache, tile_key
from .config import get_settings
from .constants import (
    MVT_EXTENT,
    WEB_MERCATOR_INITIAL_RESOLUTION,
    WEB_MERCATOR_ORIGIN_SHIFT,
    WEB_MERCATOR_SRID,
)
from .filters import compile_filter
from .models import SampleSiftCollection
from .registry import registry


def _tile_polygon(z: int, x: int, y: int) -> Any:
    if z < 0 or x < 0 or y < 0 or x >= 2**z or y >= 2**z:
        raise HttpError(422, "z, x, and y must identify a valid Web Mercator tile.")

    def longitude(column: float) -> float:
        return column / 2**z * 360.0 - 180.0

    def latitude(row: float) -> float:
        value = math.atan(math.sinh(math.pi * (1 - 2 * row / 2**z)))
        return math.degrees(value)

    west, east = longitude(x), longitude(x + 1)
    north, south = latitude(y), latitude(y + 1)
    from django.contrib.gis.geos import Polygon

    return Polygon.from_bbox((west, south, east, north))


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, time, UUID)):
        return value.isoformat()
    return value


def _field_schema(field: models.Field[Any, Any]) -> dict[str, Any]:
    if isinstance(field, models.BooleanField):
        return {"type": "boolean"}
    if isinstance(field, (models.IntegerField, models.AutoField)):
        return {"type": "integer"}
    if isinstance(field, (models.FloatField, models.DecimalField)):
        return {"type": "number"}
    if isinstance(field, models.DateTimeField):
        return {"type": "string", "format": "date-time"}
    if isinstance(field, models.DateField):
        return {"type": "string", "format": "date"}
    if isinstance(field, models.TimeField):
        return {"type": "string", "format": "time"}
    if isinstance(field, models.UUIDField):
        return {"type": "string", "format": "uuid"}
    return {"type": "string"}


def _allowed_operators(field: models.Field[Any, Any]) -> list[str]:
    operators = ["=", "<>", "in", "isNull"]
    if isinstance(
        field,
        (
            models.IntegerField,
            models.FloatField,
            models.DecimalField,
            models.DateField,
            models.TimeField,
        ),
    ) and not isinstance(field, models.BooleanField):
        operators.extend([">", ">=", "<", "<="])
    return operators


def _public_fields(collection: type[SampleSiftCollection]) -> dict[str, models.Field[Any, Any]]:
    return {
        name: field
        for name, field in collection.collection_fields().items()
        if name != "geometry"
    }


def _queryables(collection: type[SampleSiftCollection]) -> dict[str, tuple[Queryable, str]]:
    overrides = getattr(getattr(collection, "Query", None), "queryables", {})
    fields = _public_fields(collection)
    if not isinstance(overrides, dict) or set(overrides) - set(fields):
        raise ValueError("Query.queryables must map materialized field names to overrides.")
    result = {}
    for field_name, field in fields.items():
        override = overrides.get(field_name, {})
        if not isinstance(override, dict) or set(override) - {"name", "operators", "annotations"}:
            raise ValueError(f"Invalid queryable override for {field_name!r}.")
        name = override.get("name", field_name)
        operators = override.get("operators", _allowed_operators(field))
        annotations = override.get("annotations", {})
        if not isinstance(name, str) or not name or name in result or not isinstance(operators, (list, tuple)) or not set(operators) <= set(_allowed_operators(field)) or not isinstance(annotations, dict) or "operators" in annotations:
            raise ValueError(f"Invalid queryable override for {field_name!r}.")
        result[name] = (Queryable(name, _field_schema(field), tuple(operators), annotations), field_name)
    if collection.geometry is not None:
        if "geometry" in result:
            raise ValueError("The queryable name 'geometry' is reserved for spatial filtering.")
        result["geometry"] = (Queryable("geometry", {"type": "object", "description": "GeoJSON Point in EPSG:4326."}, ("s_intersects",)), "geometry")
    return result


def _apply_filters(
    query: QuerySet[models.Model], collection: type[SampleSiftCollection], payload: dict[str, Any]
) -> QuerySet[models.Model]:
    if "filters" in payload or "filter-lang" in payload:
        raise HttpError(422, "Use filter with a CQL2 JSON expression.")
    if "filter" not in payload:
        return query
    try:
        return query.filter(compile_filter(payload["filter"], _queryables(collection)))
    except (ValueError, TypeError, KeyError) as error:
        raise HttpError(422, str(error)) from error
def _ordering(collection: type[SampleSiftCollection], payload: dict[str, Any]) -> list[str]:
    ordering = payload.get("sort", collection.default_ordering())
    if not isinstance(ordering, list) or not ordering or not all(isinstance(item, str) for item in ordering):
        raise HttpError(422, "sort must be a non-empty list of field names.")
    fields = _public_fields(collection)
    result: list[str] = []
    for item in ordering:
        name = item.removeprefix("-")
        if name not in fields:
            raise HttpError(422, f"{name!r} cannot be used for sorting.")
        result.append(item)
    if "source_pk" not in {item.removeprefix("-") for item in result}:
        result.append("source_pk")
    return result


def _cursor_context(payload: dict[str, Any], ordering: list[str]) -> str:
    data = {key: payload.get(key) for key in ("filter", "sort")}
    data["ordering"] = ordering
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def _decode_cursor(cursor: str, context: str) -> list[Any]:
    try:
        decoded = base64.urlsafe_b64decode(cursor.encode()).decode()
        content = json.loads(decoded)
    except Exception as error:
        raise HttpError(422, "cursor is invalid.") from error
    if content.get("context") != context or not isinstance(content.get("values"), list):
        raise HttpError(422, "cursor does not belong to this query.")
    return content["values"]


def _encode_cursor(values: list[Any], context: str) -> str:
    content = json.dumps({"context": context, "values": [_json_value(value) for value in values]})
    return base64.urlsafe_b64encode(content.encode()).decode()


def _apply_cursor(query: QuerySet[models.Model], ordering: list[str], values: list[Any]) -> QuerySet[models.Model]:
    if len(values) != len(ordering):
        raise HttpError(422, "cursor has the wrong number of sort values.")
    conditions = Q()
    prefix = Q()
    for item, value in zip(ordering, values, strict=True):
        name, descending = item.removeprefix("-"), item.startswith("-")
        if value is None:
            raise HttpError(422, "Cursor pagination does not support null sort values.")
        comparison = "lt" if descending else "gt"
        conditions |= prefix & Q(**{f"{name}__{comparison}": value})
        prefix &= Q(**{name: value})
    return query.filter(conditions)


def _serialize_row(row: models.Model, collection: type[SampleSiftCollection]) -> dict[str, Any]:
    geometry = row.geometry
    data: dict[str, Any] = {
        "source_pk": row.source_pk,
        "geometry": None
        if geometry is None
        else {"type": "Point", "coordinates": [geometry.x, geometry.y]},
    }
    data.update({name: _json_value(getattr(row, name)) for name in _public_fields(collection)})
    return data


class SamplesiftDocs(Swagger):
    def render_page(self, request: Any, api: NinjaAPI, **kwargs: Any) -> HttpResponse:
        response = super().render_page(request, api, **kwargs)
        asset_url = reverse(f"{api.urls_namespace}:samplesift-tile-preview", kwargs=kwargs)
        schema_url = self.get_openapi_url(api, kwargs)
        markup = f'<script src="{escape(asset_url)}" data-schema-url="{escape(schema_url)}"></script>'
        response.content = response.content.replace(
            b'<div id="swagger-ui"', markup.encode() + b'<div id="swagger-ui"', 1
        )
        return response


class SamplesiftAPI(NinjaAPI):
    """Ninja API with one static operation pair for every spatial collection."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._collection_paths: dict[str, type[SampleSiftCollection]] = {}

    @property
    def urls(self) -> Any:
        registry.freeze_api()
        return super().urls

    def register_collection(self, collection: type[SampleSiftCollection]) -> None:
        name = collection.api_name()
        if any(existing.api_name() == name for existing in self._collection_paths.values()):
            return
        _queryables(collection)
        result_path = f"/collections/{name}/results"
        tile_path = f"/collections/{name}/tiles/{{z}}/{{x}}/{{y}}"
        discovery_path = f"/collections/{name}/queryables"

        def queryables_operation(request: Any) -> dict[str, Any]:
            return {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {key: descriptor.json_schema() for key, (descriptor, _) in _queryables(collection).items()}, "additionalProperties": False}

        queryables_operation.__name__ = f"{name.replace('-', '_')}_queryables"
        self.get(discovery_path, tags=[name], operation_id=f"{name.replace('-', '_')}_queryables")(queryables_operation)

        def result_operation(
            request: Any, payload: Annotated[dict[str, Any], Body(...)]
        ) -> dict[str, Any]:
            return _results_for_collection(collection, payload)

        def tile_operation(
            request: Any,
            z: int,
            x: int,
            y: int,
            payload: Annotated[dict[str, Any], Body(...)],
        ) -> HttpResponse:
            return HttpResponse(
                _cached_mvt(collection, payload, z, x, y),
                content_type="application/vnd.mapbox-vector-tile",
            )

        result_operation.__name__ = f"{name.replace('-', '_')}_results"
        tile_operation.__name__ = f"{name.replace('-', '_')}_tiles"
        self.api_operation(
            ["QUERY"],
            result_path,
            tags=[name],
            response=dict,
            operation_id=f"{name.replace('-', '_')}_results",
            openapi_extra={"x-samplesift-queryables": discovery_path},
        )(result_operation)
        self.api_operation(
            ["QUERY"],
            tile_path,
            tags=[name],
            operation_id=f"{name.replace('-', '_')}_tiles",
            openapi_extra={"x-samplesift-queryables": discovery_path},
        )(tile_operation)
        self._collection_paths[result_path] = collection
        self._collection_paths[tile_path] = collection

    def get_openapi_schema(self, **kwargs: Any) -> dict[str, Any]:
        config = get_settings()
        schema = super().get_openapi_schema(**kwargs)
        schema["openapi"] = "3.2.1"
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        for path, collection in self._collection_paths.items():
            name = collection.api_name()
            title = "".join(part.title() for part in name.split("-"))
            fields = _public_fields(collection)
            query_name = f"{title}Query"
            result_name = f"{title}Result"
            components[query_name] = {
                "type": "object",
                "properties": {
                    "filter": {"type": "object", "description": "CQL2 JSON expression; s_intersects accepts geometry and a GeoJSON Polygon or MultiPolygon in EPSG:4326."},
                    "sort": {"type": "array", "items": {"type": "string", "enum": [*fields, *[f"-{field}" for field in fields]]}},
                    "limit": {"type": "integer", "minimum": 1, "maximum": config.max_page_size, "default": config.default_page_size},
                    "offset": {"type": "integer", "minimum": 0},
                    "cursor": {"type": "string"},
                },
            }
            components[result_name] = {
                "type": "object",
                "required": ["source_pk", "geometry"],
                "properties": {
                    "source_pk": {"type": "string"},
                    "geometry": {"type": ["object", "null"], "description": "GeoJSON Point in EPSG:4326."},
                    **{field_name: _field_schema(field) for field_name, field in fields.items()},
                },
            }
            operation = next(
                (
                    item.get("query")
                    for schema_path, item in schema["paths"].items()
                    if schema_path.endswith(path)
                ),
                None,
            )
            if operation is None:
                continue
            schema_path = next(key for key in schema["paths"] if key.endswith(path))
            operation["x-samplesift-queryables"] = schema_path[: -len(path)] + f"/collections/{name}/queryables"
            operation.setdefault("requestBody", {"required": True, "content": {}})["content"][
                "application/json"
            ] = {
                "schema": {"$ref": f"#/components/schemas/{query_name}"},
                "example": getattr(getattr(collection, "Query", None), "query_example", {}),
            }
            if not path.endswith("/results"):
                tile_example = getattr(getattr(collection, "Query", None), "tile_example", None)
                if tile_example is not None:
                    for parameter in operation.get("parameters", []):
                        if parameter.get("in") == "path" and parameter.get("name") in tile_example:
                            parameter["example"] = tile_example[parameter["name"]]
            responses = operation.setdefault("responses", {})
            response_200 = responses.get("200") or responses.get(200) or {"description": "Success"}
            responses["200"] = response_200
            responses.pop(200, None)
            if path.endswith("/results"):
                response_200["content"] = {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "items": {
                                    "type": "array",
                                    "items": {"$ref": f"#/components/schemas/{result_name}"},
                                }
                            },
                        }
                    }
                }
            else:
                response_200["content"] = {
                    "application/vnd.mapbox-vector-tile": {
                        "schema": {"type": "string", "format": "binary"}
                    }
                }
        return schema


api = SamplesiftAPI(
    title="SampleSift collection API",
    version="1.0.0",
    description="Read-only spatial queries over registered SampleSift collections.",
    docs=SamplesiftDocs(),
)


@api.get("/_tile-preview.js", include_in_schema=False, url_name="samplesift-tile-preview")
def tile_preview_script(request: Any) -> HttpResponse:
    script = Path(__file__).parent / "static" / "samplesift" / "tile-preview.js"
    return HttpResponse(script.read_bytes(), content_type="application/javascript")


registry.set_api_registration_callback(api.register_collection)
for _collection in registry.api_collections:
    api.register_collection(_collection)


def _queryset(collection: type[SampleSiftCollection], payload: dict[str, Any]) -> QuerySet[models.Model]:
    model = registry.get_model(collection)
    query = model._default_manager.using(registry.target_database()).all()
    return _apply_filters(query, collection, payload)


def _cached_mvt(collection: type[SampleSiftCollection], payload: dict[str, Any], z: int, x: int, y: int) -> bytes:
    query = _queryset(collection, payload)
    _tile_polygon(z, x, y)
    cache = tile_cache()
    using = registry.target_database()
    if cache is None or connections[using].in_atomic_block:
        return _mvt(collection, query, z, x, y)
    # Read the version before the tile: a concurrent write can then only store
    # newer bytes under an older, already unreachable key.
    version = collection_version(collection, using)
    if version is None:
        return _mvt(collection, query, z, x, y)
    key = tile_key(collection, version, payload, z, x, y)
    result = cache.get(key)
    if result is None:
        result = _mvt(collection, query, z, x, y)
        cache.set(key, result, timeout=get_settings().cache_timeout)
    return result


def _results_for_collection(
    collection: type[SampleSiftCollection], payload: dict[str, Any]
) -> dict[str, Any]:
    """Return individual rows matching filters for one bound collection."""
    query = _queryset(collection, payload)
    ordering = _ordering(collection, payload)
    config = get_settings()
    limit = payload.get("limit", config.default_page_size)
    if not isinstance(limit, int) or not 1 <= limit <= config.max_page_size:
        raise HttpError(422, f"limit must be between 1 and {config.max_page_size}.")
    cursor, offset = payload.get("cursor"), payload.get("offset")
    if cursor is not None and offset is not None:
        raise HttpError(422, "cursor and offset cannot be used together.")
    query = query.order_by(*ordering)
    if cursor is not None:
        if not isinstance(cursor, str):
            raise HttpError(422, "cursor must be a string.")
        context = _cursor_context(payload, ordering)
        query = _apply_cursor(query, ordering, _decode_cursor(cursor, context))
        rows = list(query[: limit + 1])
        page, remainder = rows[:limit], rows[limit:]
        response: dict[str, Any] = {"items": [_serialize_row(row, collection) for row in page], "limit": limit}
        if remainder:
            response["next_cursor"] = _encode_cursor(
                [getattr(page[-1], item.removeprefix("-")) for item in ordering], context
            )
        return response
    if offset is None:
        offset = 0
    if not isinstance(offset, int) or offset < 0:
        raise HttpError(422, "offset must be a non-negative integer.")
    total = query.count()
    rows = list(query[offset : offset + limit])
    return {"items": [_serialize_row(row, collection) for row in rows], "limit": limit, "offset": offset, "total": total}


def _mvt(collection: type[SampleSiftCollection], query: QuerySet[models.Model], z: int, x: int, y: int) -> bytes:
    tile_bounds = _tile_polygon(z, x, y)
    connection = connections[registry.target_database()]
    if connection.vendor != "postgresql":
        raise HttpError(501, "Vector tiles require the configured PostGIS database.")
    if z > get_settings().cluster_max_zoom:
        fields = ["source_pk", *_public_fields(collection)]
        selected = ", ".join(connection.ops.quote_name(field) for field in fields)
        geometry = f"ST_AsMVTGeom(ST_Transform(geometry, {WEB_MERCATOR_SRID}), ST_TileEnvelope(%s, %s, %s), {MVT_EXTENT}, 0, true) AS geom"
        base = query.filter(geometry__intersects=tile_bounds).values(*fields, "geometry")
        base_sql, base_params = base.query.sql_with_params()
        sql = f"WITH filtered AS ({base_sql}) SELECT COALESCE(ST_AsMVT(tile, %s, {MVT_EXTENT}, 'geom'), ''::bytea) FROM (SELECT {selected}, false AS cluster, 1 AS point_count, {geometry} FROM filtered) AS tile"
        params = [*base_params, collection.api_name(), z, x, y]
    else:
        clusters_sql, clusters_params = _clusters_sql(collection, query, z)
        sql = f"""{clusters_sql} SELECT COALESCE({_tile_aggregate()}, ''::bytea) FROM (
            SELECT {_feature_columns(collection)},
            ST_AsMVTGeom(centroid, ST_TileEnvelope(%s, %s, %s), {MVT_EXTENT}, 0, true) AS geom
            FROM clusters
        ) AS tile"""
        params = [*clusters_params, collection.api_name(), z, x, y]
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return bytes(cursor.fetchone()[0])


def _clusters_sql(
    collection: type[SampleSiftCollection], query: QuerySet[models.Model], z: int
) -> tuple[str, list[Any]]:
    """Cluster the whole filtered collection once for zoom ``z``.

    Both single tiles and prewarmed zooms cut their features from these rows, so
    the two paths always agree on membership and properties.
    """
    connection = connections[registry.target_database()]
    quote = connection.ops.quote_name
    fields = ["source_pk", *_public_fields(collection)]
    base_sql, base_params = query.values(*fields, "geometry").query.sql_with_params()
    grid_size = WEB_MERCATOR_INITIAL_RESOLUTION / (2**z) * get_settings().cluster_radius_pixels
    grouped = ", ".join(
        f"CASE WHEN count(*) = 1 THEN (array_agg({quote(field)}))[1] END AS {quote(field)}"
        for field in fields
    )
    sql = f"""WITH filtered AS ({base_sql}), grouped AS (
        SELECT ST_ClusterDBSCAN(ST_Transform(geometry, {WEB_MERCATOR_SRID}), eps := %s, minpoints := 1)
            OVER (ORDER BY source_pk) AS cell, * FROM filtered
    ), clusters AS (
        SELECT {grouped}, count(*) > 1 AS cluster, count(*) AS point_count,
        md5(min(source_pk)) AS cluster_id,
        ST_Centroid(ST_Collect(ST_Transform(geometry, {WEB_MERCATOR_SRID}))) AS centroid
        FROM grouped GROUP BY cell
    )"""
    return sql, [*base_params, grid_size]


def _feature_columns(collection: type[SampleSiftCollection], source: str = "clusters") -> str:
    quote = connections[registry.target_database()].ops.quote_name
    fields = ["source_pk", *_public_fields(collection), "cluster", "point_count", "cluster_id"]
    return ", ".join(f"{source}.{quote(field)}" for field in fields)


def _tile_aggregate() -> str:
    # A fixed feature order makes prewarmed and on-demand tiles byte-identical.
    return f"ST_AsMVT(tile, %s, {MVT_EXTENT}, 'geom' ORDER BY tile.cluster_id)"


def _zoom_tiles(
    collection: type[SampleSiftCollection], query: QuerySet[models.Model], z: int
) -> Iterator[tuple[str | None, int, int, bytes]]:
    """Yield ``(version, x, y, tile)`` for every non-empty clustered tile at ``z``.

    Clustering runs once for the zoom instead of once per tile. Each centroid is
    offered to the tiles around its position; ST_AsMVTGeom then keeps exactly the
    tiles an on-demand request would include it in. The version is selected in
    the same statement, so it describes the snapshot the tiles were built from.
    """
    connection = connections[registry.target_database()]
    clusters_sql, clusters_params = _clusters_sql(collection, query, z)
    # Fractional tile coordinates; the small margin admits both neighbours of a
    # centroid on (or within rounding of) a tile edge.
    size = 2 * WEB_MERCATOR_ORIGIN_SHIFT / 2**z
    last = 2**z - 1
    column = f"(ST_X(clusters.centroid) + {WEB_MERCATOR_ORIGIN_SHIFT}) / {size}"
    row = f"({WEB_MERCATOR_ORIGIN_SHIFT} - ST_Y(clusters.centroid)) / {size}"

    def candidates(position: str) -> str:
        return (
            f"generate_series(GREATEST(floor({position} - 1e-6), 0)::int, "
            f"LEAST(floor({position} + 1e-6), {last})::int)"
        )

    sql = f"""{clusters_sql} SELECT (SELECT {VERSION_SQL}), placed.tx, placed.ty, {_tile_aggregate()}
        FROM (
            SELECT clusters.*, tx, ty FROM clusters
            CROSS JOIN LATERAL {candidates(column)} AS tx
            CROSS JOIN LATERAL {candidates(row)} AS ty
        ) AS placed
        CROSS JOIN LATERAL (
            SELECT {_feature_columns(collection, "placed")},
            ST_AsMVTGeom(placed.centroid, ST_TileEnvelope(%s, placed.tx, placed.ty), {MVT_EXTENT}, 0, true) AS geom
        ) AS tile
        WHERE tile.geom IS NOT NULL
        GROUP BY placed.tx, placed.ty"""
    params = [*clusters_params, collection.table_name(), collection.api_name(), z]
    with connection.chunked_cursor() as cursor:
        cursor.execute(sql, params)
        for version, x, y, tile in cursor:
            yield version, x, y, bytes(tile)
