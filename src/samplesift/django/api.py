"""The public, read-only API for registered SampleSift collections."""

from __future__ import annotations

import base64
import hashlib
import json
import math
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

from django.db import connections, models
from django.db.models import Q, QuerySet
from django.http import HttpResponse
from ninja import Body, NinjaAPI
from ninja.errors import HttpError

from samplesift.query import Queryable

from .filters import compile_filter
from .models import SampleSiftCollection
from .registry import registry

MAX_PAGE_SIZE = 500
DEFAULT_PAGE_SIZE = 100
CLUSTER_RADIUS_PIXELS = 40
CLUSTER_MAX_ZOOM = 14


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
                _mvt(collection, _tile_queryset(collection, payload, z, x, y), z, x, y),
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
                    "filter": {"type": "object", "description": "CQL2 JSON expression"},
                    "sort": {"type": "array", "items": {"type": "string", "enum": [*fields, *[f"-{field}" for field in fields]]}},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_PAGE_SIZE, "default": DEFAULT_PAGE_SIZE},
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
)
registry.set_api_registration_callback(api.register_collection)
for _collection in registry.api_collections:
    api.register_collection(_collection)


def _queryset(collection: type[SampleSiftCollection], payload: dict[str, Any]) -> QuerySet[models.Model]:
    model = registry.get_model(collection)
    query = model._default_manager.using(registry.target_database()).all()
    return _apply_filters(query, collection, payload)


def _tile_queryset(
    collection: type[SampleSiftCollection], payload: dict[str, Any], z: int, x: int, y: int
) -> QuerySet[models.Model]:
    return _queryset(collection, payload).filter(geometry__intersects=_tile_polygon(z, x, y))


def _results_for_collection(
    collection: type[SampleSiftCollection], payload: dict[str, Any]
) -> dict[str, Any]:
    """Return individual rows matching filters for one bound collection."""
    query = _queryset(collection, payload)
    ordering = _ordering(collection, payload)
    limit = payload.get("limit", DEFAULT_PAGE_SIZE)
    if not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise HttpError(422, f"limit must be between 1 and {MAX_PAGE_SIZE}.")
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
    connection = connections[registry.target_database()]
    if connection.vendor != "postgresql":
        raise HttpError(501, "Vector tiles require the configured PostGIS database.")
    fields = ["source_pk", *_public_fields(collection)]
    base = query.values(*fields, "geometry")
    base_sql, base_params = base.query.sql_with_params()
    quote = connection.ops.quote_name
    selected = ", ".join(quote(field) for field in fields)
    geometry = "ST_AsMVTGeom(ST_Transform(geometry, 3857), ST_TileEnvelope(%s, %s, %s), 4096, 0, true) AS geom"
    if z > CLUSTER_MAX_ZOOM:
        sql = f"WITH filtered AS ({base_sql}) SELECT COALESCE(ST_AsMVT(tile, %s, 4096, 'geom'), ''::bytea) FROM (SELECT {selected}, false AS cluster, 1 AS point_count, {geometry} FROM filtered) AS tile"
        params = [*base_params, collection.api_name(), z, x, y]
    else:
        grid_size = 156543.03392804097 / (2**z) * CLUSTER_RADIUS_PIXELS
        grouped = ", ".join(
            f"CASE WHEN count(*) = 1 THEN (array_agg({quote(field)}))[1] END AS {quote(field)}"
            for field in fields
        )
        sql = f"""WITH filtered AS ({base_sql}), grouped AS (
            SELECT ST_SnapToGrid(ST_Transform(geometry, 3857), %s) AS cell, * FROM filtered
        ) SELECT COALESCE(ST_AsMVT(tile, %s, 4096, 'geom'), ''::bytea) FROM (
            SELECT {grouped}, count(*) > 1 AS cluster, count(*) AS point_count,
            encode(ST_AsEWKB(cell), 'hex') AS cluster_id,
            ST_AsMVTGeom(ST_Centroid(ST_Collect(ST_Transform(geometry, 3857))), ST_TileEnvelope(%s, %s, %s), 4096, 0, true) AS geom
            FROM grouped GROUP BY cell
        ) AS tile"""
        params = [*base_params, grid_size, collection.api_name(), z, x, y]
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return bytes(cursor.fetchone()[0])
