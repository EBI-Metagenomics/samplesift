"""Verify actual spatial indexes on runtime-managed collection tables."""

from typing import ClassVar

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, models

from samplesift.django import Point, SampleSiftCollection
from samplesift.django.registry import CollectionRegistry


class IndexedSource(models.Model):
    """Declare numeric coordinates without a source spatial index."""

    lon = models.FloatField()
    lat = models.FloatField()

    class Meta:
        app_label = "samplesift_index_tests"


class IndexedCollection(SampleSiftCollection):
    """Declare a spatial index on the derived collection."""

    fields: ClassVar[list[str]] = ["lon", "lat"]
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = IndexedSource

    class Query:
        default_ordering: ClassVar[list[str]] = ["lon"]


_registry = CollectionRegistry()
_registry.register(IndexedCollection)


@pytest.fixture
def indexed_model(transactional_db, monkeypatch):
    """Isolate a runtime table from other registered collections."""
    monkeypatch.setattr(
        "samplesift.django.management.commands.samplesift_sync_schema.registry",
        _registry,
    )
    model = _registry.get_model(IndexedCollection)
    yield model
    with connection.schema_editor() as editor:
        if model._meta.db_table in connection.introspection.table_names():
            editor.delete_model(model)


@pytest.mark.parametrize("legacy", [False, True])
def test_schema_creates_and_repairs_actual_spatial_index(indexed_model, legacy) -> None:
    """Create the GiST index on new and legacy tables, without rebuilding it."""
    model = indexed_model
    index = model._meta.indexes[0]
    if legacy:
        with connection.schema_editor() as editor:
            editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            editor.create_model(model)
    call_command("samplesift_sync_schema", no_warm_cache=True)
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(
            cursor, model._meta.db_table
        )
        assert constraints[index.name]["type"] == "gist"
        assert constraints[index.name]["columns"] == ["geometry"]
        cursor.execute(
            "SELECT oid FROM pg_class WHERE oid = %s::regclass", [index.name]
        )
        previous_oid = cursor.fetchone()[0]
    call_command("samplesift_sync_schema", no_warm_cache=True)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT oid FROM pg_class WHERE oid = %s::regclass", [index.name]
        )
        assert cursor.fetchone()[0] == previous_oid
    assert model._meta.managed is False


@pytest.mark.parametrize("partial", [False, True])
def test_schema_reports_incompatible_existing_index(indexed_model, partial) -> None:
    """Report an incompatible index instead of silently accepting its name."""
    model = indexed_model
    index = model._meta.indexes[0]
    with connection.schema_editor() as editor:
        editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        editor.create_model(model)
        if partial:
            editor.execute(
                f'CREATE INDEX "{index.name}" ON "{model._meta.db_table}" USING gist (geometry) WHERE lon > 0'
            )
        else:
            editor.execute(
                f'CREATE INDEX "{index.name}" ON "{model._meta.db_table}" (lon)'
            )
    with pytest.raises(CommandError, match="Index drift"):
        call_command("samplesift_sync_schema", no_warm_cache=True)
