from __future__ import annotations

from typing import ClassVar

import pytest
from django.db import models

from samplesift.django import SampleSiftCollection, registry
from samplesift.django.api import api
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


class AirQualitySample(models.Model):
    class Meta:
        app_label = "samplesift_api_tests"


class DefaultNamedCollection(SampleSiftCollection):
    class Meta:
        model = AirQualitySample


registry.register(ApiSampleCollection)
# Fast SQLite tests do not load GDAL. The PostGIS integration suite exercises
# Point materialisation; this test isolates the registry-driven OAS expansion.
registry._api_names["api-samples"] = ApiSampleCollection
api.register_collection(ApiSampleCollection)


def test_openapi_describes_query_operations_and_registered_collection() -> None:
    schema = api.get_openapi_schema(path_prefix="/samplesift")

    assert schema["openapi"] == "3.2.1"
    assert "query" in schema["paths"]["/samplesift/api-samples/results"]
    assert "query" in schema["paths"]["/samplesift/api-samples/tiles/{z}/{x}/{y}"]
    components = schema["components"]["schemas"]
    assert "collection" not in components["ApiSamplesQuery"]["properties"]
    assert "ApiSamplesResult" in components
    request_schema = schema["paths"]["/samplesift/api-samples/results"]["query"]["requestBody"][
        "content"
    ]["application/json"]["schema"]
    assert request_schema == {"$ref": "#/components/schemas/ApiSamplesQuery"}


def test_api_name_defaults_to_the_source_model_class_name() -> None:
    assert DefaultNamedCollection.api_name() == "air-quality-sample"


def test_spatial_registration_is_rejected_after_api_freeze() -> None:
    frozen_registry = CollectionRegistry()
    frozen_registry.freeze_api()

    class FrozenCollection(SampleSiftCollection):
        geometry = object()  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="routes are frozen"):
        frozen_registry.register(FrozenCollection)
