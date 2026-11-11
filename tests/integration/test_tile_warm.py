from typing import ClassVar
from unittest.mock import MagicMock

import pytest
from django.core.cache import caches
from django.core.management import call_command
from django.db import connection, models

from samplesift.django import Point, SampleSiftCollection
from samplesift.django.api import _cached_mvt, _mvt, _zoom_tiles
from samplesift.django.cache import VERSION_TABLE, collection_version
from samplesift.django.registry import CollectionRegistry


class WarmSource(models.Model):
    lon = models.FloatField()
    lat = models.FloatField()
    label = models.CharField(max_length=30)

    class Meta:
        app_label = "samplesift_warm_tests"


class WarmCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["label"]
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = WarmSource
        api_name = "warm-samples"

    class Query:
        default_ordering: ClassVar[list[str]] = ["label"]


# One registry avoids re-registering the runtime collection model per test.
_registry = CollectionRegistry()
_registry.register(WarmCollection)


@pytest.fixture
def warm_registry(monkeypatch, settings):
    settings.SAMPLESIFT_CLUSTER_MAX_ZOOM = 3
    monkeypatch.setattr("samplesift.django.management.commands.samplesift_sync_schema.registry", _registry)
    model = _registry.get_model(WarmCollection)
    yield model
    with connection.schema_editor() as editor:
        if model._meta.db_table in connection.introspection.table_names():
            editor.delete_model(model)
        editor.execute(f"DROP TABLE IF EXISTS {VERSION_TABLE}")


def _populate(model):
    from django.contrib.gis.geos import Point as GeoPoint

    rows = [(lon, lat) for lon in range(-170, 180, 37) for lat in range(-70, 80, 29)]
    # Centroids exactly on tile edges at every zoom, and one pair that clusters.
    rows += [(0, 0), (90, 0), (-90, 0), (0.01, 45), (0.02, 45)]
    model.objects.bulk_create(
        model(source_pk=f"p{index}", label=f"l{index % 3}", geometry=GeoPoint(lon, lat, srid=4326))
        for index, (lon, lat) in enumerate(rows)
    )


@pytest.mark.django_db(transaction=True)
def test_writes_change_version(warm_registry):
    model = warm_registry
    call_command("samplesift_sync_schema", "--no-warm-cache")
    versions = [collection_version(WarmCollection, "default")]
    assert versions[0] is not None

    def write(sql=None):
        if sql:
            with connection.cursor() as cursor:
                cursor.execute(sql)
        versions.append(collection_version(WarmCollection, "default"))
        assert versions[-1] != versions[-2]

    model.objects.create(source_pk="a", label="x")
    write()
    model.objects.update(label="y")
    write()
    write(f'DELETE FROM "{model._meta.db_table}"')
    write(f'TRUNCATE "{model._meta.db_table}"')


@pytest.mark.django_db(transaction=True)
def test_zoom_tiles_match_on_demand_tiles(warm_registry):
    model = warm_registry
    call_command("samplesift_sync_schema", "--no-warm-cache")
    _populate(model)
    version = collection_version(WarmCollection, "default")
    query = model.objects.all()
    for z in range(4):
        warmed = {}
        for tile_version, x, y, tile in _zoom_tiles(WarmCollection, query, z):
            assert tile_version == version
            warmed[(x, y)] = tile
        assert warmed
        for x in range(2**z):
            for y in range(2**z):
                assert warmed.pop((x, y), b"") == _mvt(WarmCollection, query, z, x, y), (z, x, y)
        assert not warmed


@pytest.mark.django_db(transaction=True)
def test_sync_schema_warms_empty_query_tiles(warm_registry, settings, monkeypatch):
    model = warm_registry
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "warm"}}
    caches["default"].clear()
    call_command("samplesift_sync_schema", "--no-warm-cache")
    _populate(model)
    call_command("samplesift_sync_schema")
    monkeypatch.setattr("samplesift.django.api._queryset", lambda *args: model.objects.all())
    build = MagicMock(side_effect=_mvt)
    monkeypatch.setattr("samplesift.django.api._mvt", build)
    _cached_mvt(WarmCollection, {}, 0, 0, 0)
    _cached_mvt(WarmCollection, {"filter": None}, 3, 4, 3)
    build.assert_not_called()
    model.objects.filter(source_pk="p0").delete()
    _cached_mvt(WarmCollection, {}, 0, 0, 0)
    build.assert_called_once()
