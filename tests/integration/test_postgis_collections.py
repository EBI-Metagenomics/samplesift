from __future__ import annotations

from typing import ClassVar

import pytest
from django.core.management import call_command
from django.db import connection, connections, models

from samplesift.django import SampleSiftCollection, registry

pytestmark = pytest.mark.skipif(
    connection.vendor != "postgresql",
    reason="Run with DJANGO_SETTINGS_MODULE=tests.postgis_settings against Docker PostGIS.",
)


class SchemaSample(models.Model):
    temperature = models.FloatField()

    class Meta:
        app_label = "samplesift_integration_tests"


class SchemaSampleCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["temperature"]

    class Meta:
        model = SchemaSample


registry.register(SchemaSampleCollection)


@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_sync_schema_enables_postgis_and_creates_registered_tables() -> None:
    call_command("samplesift_sync_schema")

    with connections["samplesift"].cursor() as cursor:
        cursor.execute("SELECT postgis_version()")
        assert cursor.fetchone()[0]

    assert registry.get_model(SchemaSampleCollection)._meta.db_table in connections[
        "samplesift"
    ].introspection.table_names()


def test_spatial_collection_registers_gist_index() -> None:
    from django.contrib.postgres.indexes import GistIndex

    from samplesift.django import Point
    from samplesift.django.registry import CollectionRegistry

    class SpatialSample(models.Model):
        lon = models.FloatField()
        lat = models.FloatField()

        class Meta:
            app_label = "samplesift_integration_tests"

    class SpatialSampleCollection(SampleSiftCollection):
        fields: ClassVar[list[str]] = ["lon", "lat"]
        geometry = Point(longitude="lon", latitude="lat")

        class Meta:
            model = SpatialSample

        class Query:
            default_ordering: ClassVar[list[str]] = ["lon"]

    local_registry = CollectionRegistry()
    local_registry.register(SpatialSampleCollection)
    indexes = local_registry.get_model(SpatialSampleCollection)._meta.indexes
    assert len(indexes) == 1
    assert isinstance(indexes[0], GistIndex)
    assert indexes[0].fields == ["geometry"]



@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_spatial_schema_can_be_validated_after_creation() -> None:
    from samplesift.django import Point
    from samplesift.django.management.commands.samplesift_sync_schema import Command
    from samplesift.django.registry import CollectionRegistry

    class SpatialSchemaSample(models.Model):
        lon = models.FloatField()
        lat = models.FloatField()

        class Meta:
            app_label = "samplesift_integration_tests"

    class SpatialSchemaCollection(SampleSiftCollection):
        fields: ClassVar[list[str]] = ["lon", "lat"]
        geometry = Point(longitude="lon", latitude="lat")

        class Meta:
            model = SpatialSchemaSample

        class Query:
            default_ordering: ClassVar[list[str]] = ["lon"]

    local_registry = CollectionRegistry()
    local_registry.register(SpatialSchemaCollection)
    model = local_registry.get_model(SpatialSchemaCollection)
    target = connections["samplesift"]
    with target.schema_editor() as editor:
        editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        editor.create_model(model)
    try:
        assert Command()._drift(target, model) == []
    finally:
        with target.schema_editor() as editor:
            editor.delete_model(model)
