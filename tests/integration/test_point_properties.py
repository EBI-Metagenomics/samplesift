"""JSON coordinates synchronise into typed columns and PostGIS geometry."""

from typing import ClassVar

import pytest
from django.db import connections, models

from samplesift.django import Point, Property, SampleSiftCollection
from samplesift.django.registry import CollectionRegistry


class JsonPointSample(models.Model):
    metadata = models.JSONField(default=dict)

    class Meta:
        app_label = "samplesift_point_integration_tests"


class JsonPointCollection(SampleSiftCollection):
    lat = Property(models.FloatField(null=True))
    lon = Property(models.FloatField(null=True))
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = JsonPointSample

    class Query:
        default_ordering: ClassVar[list[str]] = ["lat"]

    @staticmethod
    def prepare_lat(sample: JsonPointSample) -> float | None:
        return sample.metadata.get("lat")

    @staticmethod
    def prepare_lon(sample: JsonPointSample) -> float | None:
        return sample.metadata.get("lon")


_registry = CollectionRegistry()
_registry.register(JsonPointCollection)


@pytest.mark.parametrize("target_alias", ["default", "samplesift"])
@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_prepared_coordinates_sync_on_source_save(
    target_alias: str, settings: object
) -> None:
    settings.SAMPLESIFT_DATABASE_ALIAS = target_alias
    model = _registry.get_model(JsonPointCollection)
    source = connections["default"]
    target = connections[target_alias]
    with source.schema_editor() as editor:
        editor.create_model(JsonPointSample)
    try:
        with target.schema_editor() as editor:
            editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            editor.create_model(model)
        try:
            sample = JsonPointSample.objects.create(metadata={"lat": 58.5, "lon": 2})
            row = model.objects.using(target_alias).get(source_pk=str(sample.pk))
            assert row.geometry.coords == (row.lon, row.lat) == (2, 58.5)
            assert row.geometry.srid == 4326

            sample.metadata = {"lat": 59, "lon": 0}
            sample.save()
            row.refresh_from_db(using=target_alias)
            assert row.geometry.coords == (row.lon, row.lat) == (0, 59)

            sample.metadata = {"lon": 2}
            sample.save()
            row.refresh_from_db(using=target_alias)
            assert row.lat is None
            assert row.geometry is None
        finally:
            with target.schema_editor() as editor:
                editor.delete_model(model)
    finally:
        with source.schema_editor() as editor:
            editor.delete_model(JsonPointSample)
