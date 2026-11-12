"""Content refresh reconciles derived rows without saving source objects."""

from collections.abc import Iterator
from io import StringIO
from typing import ClassVar

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connections, models

from samplesift.django import Point, Property, SampleSiftCollection
from samplesift.django.registry import CollectionRegistry


class RefreshSample(models.Model):
    label = models.CharField(max_length=30)
    metadata = models.JSONField(default=dict)

    class Meta:
        app_label = "samplesift_refresh_tests"


class RefreshCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["label"]
    lat = Property(models.FloatField(null=True))
    lon = Property(models.FloatField(null=True))
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = RefreshSample
        api_name = "refresh-samples"

    class Query:
        default_ordering: ClassVar[list[str]] = ["label"]

    @staticmethod
    def prepare_lat(sample: RefreshSample) -> float | None:
        return sample.metadata.get("lat")

    @staticmethod
    def prepare_lon(sample: RefreshSample) -> float | None:
        return sample.metadata.get("lon")


class SummaryCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["label"]

    class Meta:
        model = RefreshSample
        api_name = "refresh-summary"
        table_name = "samplesift_refresh_summary_collection"


_registry = CollectionRegistry()
_registry.register(RefreshCollection)
_registry.register(SummaryCollection)


@pytest.fixture(params=["default", "samplesift"])
def storage(
    request: pytest.FixtureRequest, settings: object, monkeypatch: pytest.MonkeyPatch
) -> Iterator[str]:
    alias = request.param
    settings.SAMPLESIFT_DATABASE_ALIAS = alias
    monkeypatch.setattr(
        "samplesift.django.management.commands.samplesift_sync_content.registry",
        _registry,
    )
    with connections["default"].schema_editor() as editor:
        editor.create_model(RefreshSample)
    with connections[alias].schema_editor() as editor:
        editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        for collection in _registry.collections:
            editor.create_model(_registry.get_model(collection))
    try:
        yield alias
    finally:
        connection = connections[alias]
        tables = connection.introspection.table_names()
        with connection.schema_editor() as editor:
            for collection in _registry.collections:
                model = _registry.get_model(collection)
                if model._meta.db_table in tables:
                    editor.delete_model(model)
        with connections["default"].schema_editor() as editor:
            editor.delete_model(RefreshSample)


pytestmark = pytest.mark.django_db(
    databases=["default", "samplesift"], transaction=True
)


def test_default_refreshes_all_collections_and_removes_orphans(
    storage: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second = RefreshSample.objects.bulk_create(
        [
            RefreshSample(label="first", metadata={"lat": 58.5, "lon": 2}),
            RefreshSample(label="second", metadata={"lat": 59, "lon": 0}),
        ]
    )
    rows = _registry.get_model(RefreshCollection).objects.using(storage)
    rows.create(source_pk=str(first.pk), label="outdated")
    rows.create(source_pk="orphan", label="deleted source")
    summary = _registry.get_model(SummaryCollection).objects.using(storage)
    summary.create(source_pk="orphan", label="deleted source")

    def fail_save(*args: object, **kwargs: object) -> None:
        raise AssertionError("Content sync must not save source records.")

    monkeypatch.setattr(RefreshSample, "save", fail_save)
    output = StringIO()
    call_command("samplesift_sync_content", stdout=output)
    assert rows.count() == summary.count() == 2
    assert not rows.filter(source_pk="orphan").exists()
    assert not summary.filter(source_pk="orphan").exists()
    row = rows.get(source_pk=str(first.pk))
    assert row.label == "first"
    assert row.geometry.coords == (row.lon, row.lat) == (2, 58.5)
    assert row.geometry.srid == 4326
    assert rows.get(source_pk=str(second.pk)).geometry.coords == (0, 59)
    assert (
        "Synced refresh-samples: 2 source rows; removed 1 orphaned rows"
        in output.getvalue()
    )
    call_command("samplesift_sync_content", stdout=StringIO())
    assert rows.count() == summary.count() == 2


def test_named_collection_recomputes_values_without_touching_other_collection(
    storage: str,
) -> None:
    (sample,) = RefreshSample.objects.bulk_create(
        [RefreshSample(label="old", metadata={"lat": 58, "lon": 2})]
    )
    call_command("samplesift_sync_content", stdout=StringIO())
    RefreshSample.objects.filter(pk=sample.pk).update(
        label="new", metadata={"lat": 60, "lon": 3}
    )
    call_command("samplesift_sync_content", "refresh-samples", stdout=StringIO())
    row = (
        _registry.get_model(RefreshCollection)
        .objects.using(storage)
        .get(source_pk=str(sample.pk))
    )
    assert row.label == "new"
    assert row.geometry.coords == (3, 60)
    summary = (
        _registry.get_model(SummaryCollection)
        .objects.using(storage)
        .get(source_pk=str(sample.pk))
    )
    assert summary.label == "old"


def test_missing_schema_fails_before_updating_any_collection(storage: str) -> None:
    model = _registry.get_model(SummaryCollection)
    with connections[storage].schema_editor() as editor:
        editor.delete_model(model)
    RefreshSample.objects.bulk_create([RefreshSample(label="not synced")])
    with pytest.raises(CommandError, match="samplesift_sync_schema"):
        call_command("samplesift_sync_content")
    assert not _registry.get_model(RefreshCollection).objects.using(storage).exists()


def test_empty_source_removes_all_orphans(storage: str) -> None:
    rows = _registry.get_model(SummaryCollection).objects.using(storage)
    rows.create(source_pk="orphan", label="gone")
    call_command("samplesift_sync_content", "refresh-summary", stdout=StringIO())
    assert not rows.exists()
