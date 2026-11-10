"""Compile the supported CQL2 subset into null-aware Django predicates."""

import json
import math
from datetime import date, datetime, time
from typing import Any
from uuid import UUID

from django.db.models import Q
from pygeofilter import ast, values
from pygeofilter.parsers.cql2_json import parse


def compile_filter(expression: Any, descriptors: dict[str, tuple[Any, str]]) -> Q:
    def shape(node: Any, depth: int = 0) -> int:
        if depth > 20:
            raise ValueError("Filter is too deeply nested.")
        if isinstance(node, dict):
            if "op" in node:
                op, args = node.get("op"), node.get("args")
                if set(node) != {"op", "args"} or not isinstance(args, list):
                    raise ValueError("Invalid expression shape.")
                if op not in {"and", "or", "not", "isNull", "=", "<>", "<", "<=", ">", ">=", "in", "s_intersects"}:
                    raise ValueError("Unsupported operator.")
                if (op in {"and", "or"} and len(args) < 2) or (op in {"not", "isNull"} and len(args) != 1) or (op not in {"and", "or", "not", "isNull"} and len(args) != 2):
                    raise ValueError("Invalid operator arity.")
            elif not (set(node) in ({"property"}, {"date"}, {"timestamp"}, {"type", "coordinates"})):
                raise ValueError("Unsupported expression value.")
            return 1 + sum(shape(v, depth + 1) for v in node.values())
        if isinstance(node, list):
            return 1 + sum(shape(v, depth + 1) for v in node)
        return 1

    if shape(expression) > 500:
        raise ValueError("Filter is too complex.")
    try:
        parsed = parse(expression)
    except Exception as error:
        raise ValueError("Invalid CQL2 JSON expression.") from error

    def property_for(node: Any, op: str) -> tuple[Any, str]:
        if not isinstance(node, ast.Attribute) or node.name not in descriptors:
            raise ValueError("Unknown queryable property.")
        descriptor, field_name = descriptors[node.name]
        if op not in descriptor.operators:
            raise ValueError(f"Operator {op!r} is not allowed for {node.name!r}.")
        return descriptor, field_name

    def literal(value: Any, descriptor: Any) -> Any:
        kind = descriptor.schema["type"]
        valid = ((kind == "string" and isinstance(value, (str, date, datetime))) or
                 (kind == "boolean" and isinstance(value, bool)) or
                 (kind == "integer" and isinstance(value, int) and not isinstance(value, bool)) or
                 (kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool)))
        if not valid:
            raise ValueError("Filter literal has an incompatible type.")
        format_name = descriptor.schema.get("format")
        if format_name and isinstance(value, str):
            try:
                {"date": date.fromisoformat, "date-time": datetime.fromisoformat,
                 "time": time.fromisoformat, "uuid": UUID}[format_name](value)
            except (ValueError, TypeError) as error:
                raise ValueError(f"Invalid {format_name} literal.") from error
        if format_name == "date" and isinstance(value, datetime):
            raise ValueError("Expected a date literal.")
        if format_name == "date-time" and isinstance(value, date) and not isinstance(value, datetime):
            raise ValueError("Expected a timestamp literal.")
        return value

    def polygon(value: Any) -> Any:
        from django.contrib.gis.geos import GEOSException, GEOSGeometry

        if not isinstance(value, values.Geometry):
            raise TypeError("Expected a GeoJSON Polygon or MultiPolygon.")
        data = value.geometry
        if not isinstance(data, dict) or set(data) != {"type", "coordinates"} or data["type"] not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Expected a GeoJSON Polygon or MultiPolygon.")

        def coordinates(items: Any, depth: int) -> None:
            if not isinstance(items, list) or not items:
                raise ValueError("Invalid polygon coordinates.")
            if depth == 0:
                if len(items) != 2 or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in items):
                    raise ValueError("Invalid polygon coordinates.")
                if not (-180 <= items[0] <= 180 and -90 <= items[1] <= 90):
                    raise ValueError("Polygon coordinates must be longitude and latitude in EPSG:4326.")
            else:
                for item in items:
                    coordinates(item, depth - 1)

        coordinates(data["coordinates"], 2 if data["type"] == "Polygon" else 3)
        try:
            geometry = GEOSGeometry(json.dumps(data), srid=4326)
            if geometry.empty or not geometry.valid:
                raise ValueError("Invalid polygon geometry.")
        except (GEOSException, ValueError, TypeError) as error:
            raise ValueError("Invalid polygon geometry.") from error
        return geometry

    def walk(node: Any) -> tuple[Q, Q]:
        if isinstance(node, ast.Not):
            true, false = walk(node.sub_node)
            return false, true
        if isinstance(node, (ast.And, ast.Or)):
            lt, lf = walk(node.lhs)
            rt, rf = walk(node.rhs)
            return (lt & rt, lf | rf) if isinstance(node, ast.And) else (lt | rt, lf & rf)
        if isinstance(node, ast.IsNull):
            _, name = property_for(node.lhs, "isNull")
            return Q(**{f"{name}__isnull": True}), Q(**{f"{name}__isnull": False})
        if isinstance(node, ast.GeometryIntersects):
            _, name = property_for(node.lhs, "s_intersects")
            match = Q(**{f"{name}__intersects": polygon(node.rhs)})
        elif isinstance(node, ast.In):
            descriptor, name = property_for(node.lhs, "in")
            if not isinstance(node.sub_nodes, list) or not node.sub_nodes:
                raise ValueError("IN requires a non-empty list.")
            values = [literal(value, descriptor) for value in node.sub_nodes]
            match = Q(**{f"{name}__in": values})
        elif isinstance(node, ast.Comparison):
            op = node.op.value
            descriptor, name = property_for(node.lhs, op)
            value = literal(node.rhs, descriptor)
            lookup = {"=": "exact", "<>": "exact", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte"}[op]
            match = Q(**{f"{name}__{lookup}": value})
            if op == "<>":
                match = ~match
        else:
            raise TypeError("Unsupported CQL2 expression.")
        present = Q(**{f"{name}__isnull": False})
        return present & match, present & ~match

    return walk(parsed)[0]
