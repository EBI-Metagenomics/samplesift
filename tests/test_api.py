from __future__ import annotations

from typing import ClassVar

import pytest
from django.db import models

from samplesift.django import SampleSiftCollection, registry
from samplesift.django.api import _queryables, api
from samplesift.django.registry import CollectionRegistry


class ApiSample(models.Model):
    label = models.CharField(max_length=40)
    score = models.IntegerField()

    class Meta:
        app_label = "samplesift_api_tests"


class ApiSampleCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["label", "score"]

    class Meta:
        model = ApiSample
        api_name = "api-samples"

    class Query:
        default_ordering: ClassVar[list[str]] = ["-score"]
        query_example: ClassVar[dict] = {"filter": {"op": ">=", "args": [{"property": "score"}, 10]}}
        tile_example: ClassVar[dict[str, int]] = {"z": 10, "x": 543, "y": 309}


class AirQualitySample(models.Model):
    class Meta:
        app_label = "samplesift_api_tests"


class DefaultNamedCollection(SampleSiftCollection):
    class Meta:
        model = AirQualitySample


registry.register(ApiSampleCollection)
# The PostGIS integration suite exercises Point materialisation; this test
# isolates the registry-driven OAS expansion.
registry._api_names["api-samples"] = ApiSampleCollection
api.register_collection(ApiSampleCollection)


def test_openapi_describes_query_operations_and_registered_collection() -> None:
    schema = api.get_openapi_schema(path_prefix="/samplesift")

    assert schema["openapi"] == "3.2.1"
    assert "query" in schema["paths"]["/samplesift/collections/api-samples/results"]
    assert "query" in schema["paths"]["/samplesift/collections/api-samples/tiles/{z}/{x}/{y}"]
    assert "get" in schema["paths"]["/samplesift/collections/api-samples/queryables"]
    components = schema["components"]["schemas"]
    assert "collection" not in components["ApiSamplesQuery"]["properties"]
    assert "ApiSamplesResult" in components
    assert schema["paths"]["/samplesift/collections/api-samples/results"]["query"]["x-samplesift-queryables"] == "/samplesift/collections/api-samples/queryables"
    request_schema = schema["paths"]["/samplesift/collections/api-samples/results"]["query"]["requestBody"][
        "content"
    ]["application/json"]["schema"]
    assert request_schema == {"$ref": "#/components/schemas/ApiSamplesQuery"}
    for suffix in ("results", "tiles/{z}/{x}/{y}"):
        body = schema["paths"][f"/samplesift/collections/api-samples/{suffix}"]["query"]["requestBody"]
        assert body["content"]["application/json"]["example"] == ApiSampleCollection.Query.query_example
    tile = schema["paths"]["/samplesift/collections/api-samples/tiles/{z}/{x}/{y}"]["query"]
    assert {param["name"]: param["example"] for param in tile["parameters"]} == {
        "z": 10, "x": 543, "y": 309
    }


def test_queryable_alias_and_capabilities() -> None:
    class AliasedCollection(ApiSampleCollection):
        class Query:
            queryables: ClassVar[dict] = {"score": {"name": "rating", "operators": ["=", "isNull"], "annotations": {"unit": "points"}}}

    descriptors = _queryables(AliasedCollection)
    descriptor, field = descriptors["rating"]
    assert field == "score"
    assert descriptor.json_schema()["x-samplesift"] == {"operators": ["=", "isNull"], "unit": "points"}
    assert "score" not in descriptors


def test_api_name_defaults_to_the_source_model_class_name() -> None:
    assert DefaultNamedCollection.api_name() == "air-quality-sample"


def test_spatial_registration_is_rejected_after_api_freeze() -> None:
    frozen_registry = CollectionRegistry()
    frozen_registry.freeze_api()

    class FrozenCollection(SampleSiftCollection):
        geometry = object()  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="routes are frozen"):
        frozen_registry.register(FrozenCollection)


def test_openapi_uses_configured_pagination(settings) -> None:
    settings.SAMPLESIFT_DEFAULT_PAGE_SIZE = 7
    settings.SAMPLESIFT_MAX_PAGE_SIZE = 12
    schema = api.get_openapi_schema(path_prefix="/samplesift")
    limit = schema["components"]["schemas"]["ApiSamplesQuery"]["properties"]["limit"]
    assert limit["default"] == 7
    assert limit["maximum"] == 12


def test_results_use_configured_pagination(settings, monkeypatch) -> None:
    from ninja.errors import HttpError

    from samplesift.django.api import _results_for_collection

    class EmptyQuery:
        def order_by(self, *args):
            return self

        def count(self):
            return 0

        def __getitem__(self, item):
            return []

    monkeypatch.setattr("samplesift.django.api._queryset", lambda *args: EmptyQuery())
    settings.SAMPLESIFT_DEFAULT_PAGE_SIZE = 7
    settings.SAMPLESIFT_MAX_PAGE_SIZE = 12
    assert _results_for_collection(ApiSampleCollection, {})["limit"] == 7
    assert _results_for_collection(ApiSampleCollection, {"limit": 12})["limit"] == 12
    with pytest.raises(HttpError, match="between 1 and 12"):
        _results_for_collection(ApiSampleCollection, {"limit": 13})


def test_tile_clustering_uses_configured_zoom_and_radius(settings, monkeypatch) -> None:
    from unittest.mock import MagicMock

    from samplesift.django.api import _mvt
    from samplesift.django.constants import WEB_MERCATOR_INITIAL_RESOLUTION

    settings.SAMPLESIFT_CLUSTER_MAX_ZOOM = 2
    settings.SAMPLESIFT_CLUSTER_RADIUS_PIXELS = 9
    monkeypatch.setattr("samplesift.django.api._tile_polygon", lambda *args: object())
    monkeypatch.setattr(registry, "target_database", lambda: "configured")
    connection = MagicMock(vendor="postgresql")
    connection.ops.quote_name.side_effect = lambda value: value
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (b"tile",)
    monkeypatch.setattr("samplesift.django.api.connections", {"configured": connection})
    query = MagicMock()
    query.values.return_value.query.sql_with_params.return_value = ("SELECT 1", [])
    query.filter.return_value.values.return_value.query.sql_with_params.return_value = ("SELECT 1", [])

    assert _mvt(ApiSampleCollection, query, 2, 0, 0) == b"tile"
    sql, params = cursor.execute.call_args.args
    assert "ST_ClusterDBSCAN" in sql
    assert params[0] == WEB_MERCATOR_INITIAL_RESOLUTION / 4 * 9

    _mvt(ApiSampleCollection, query, 3, 0, 0)
    assert "ST_ClusterDBSCAN" not in cursor.execute.call_args.args[0]
