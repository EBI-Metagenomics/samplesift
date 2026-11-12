from unittest.mock import MagicMock

import pytest
from django.core.cache import caches
from ninja.errors import HttpError

from samplesift.django.api import _cached_mvt
from samplesift.django.cache import tile_cache, tile_key, warm_collection
from tests.test_api import ApiSampleCollection


@pytest.fixture
def version():
    return {"value": "1"}


@pytest.fixture
def configured_cache(settings, monkeypatch, version):
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache = caches["default"]
    cache.clear()
    monkeypatch.setattr("samplesift.django.api._queryset", lambda *args: object())
    monkeypatch.setattr("samplesift.django.api.registry.target_database", lambda: "default")
    monkeypatch.setattr("samplesift.django.api.connections", {"default": MagicMock(in_atomic_block=False)})
    monkeypatch.setattr("samplesift.django.api.collection_version", lambda *args: version["value"])
    return cache


def test_no_explicit_cache(settings):
    # The test settings module does not define CACHES, although Django supplies a default.
    assert tile_cache() is None


def test_cache_hit_keys_and_version_change(configured_cache, settings, monkeypatch, version):
    build = MagicMock(return_value=b"")
    monkeypatch.setattr("samplesift.django.api._mvt", build)
    assert _cached_mvt(ApiSampleCollection, {}, 1, 0, 0) == b""
    assert _cached_mvt(ApiSampleCollection, {}, 1, 0, 0) == b""
    assert build.call_count == 1
    _cached_mvt(ApiSampleCollection, {"filter": 1}, 1, 0, 0)
    _cached_mvt(ApiSampleCollection, {}, 1, 1, 0)
    settings.SAMPLESIFT_CLUSTER_RADIUS_PIXELS = 10
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    assert build.call_count == 4
    version["value"] = "2"
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    assert build.call_count == 5


def test_version_change_during_tile_build(configured_cache, monkeypatch, version):
    def build(*args):
        version["value"] = "2"
        return b"old"

    mock = MagicMock(side_effect=build)
    monkeypatch.setattr("samplesift.django.api._mvt", mock)
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    assert mock.call_count == 2


@pytest.mark.parametrize("bypass", ["no_version", "atomic"])
def test_cache_bypass(configured_cache, monkeypatch, version, bypass):
    if bypass == "no_version":
        version["value"] = None
    else:
        monkeypatch.setattr("samplesift.django.api.connections", {"default": MagicMock(in_atomic_block=True)})
    build = MagicMock(return_value=b"tile")
    monkeypatch.setattr("samplesift.django.api._mvt", build)
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    assert build.call_count == 2


def test_validation_precedes_cache_lookup(configured_cache, monkeypatch):
    monkeypatch.setattr("samplesift.django.api._mvt", lambda *args: b"tile")
    _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)
    with pytest.raises(HttpError):
        _cached_mvt(ApiSampleCollection, {}, 1, 2, 0)
    def invalid(*args):
        raise HttpError(422, "invalid filter")
    monkeypatch.setattr("samplesift.django.api._queryset", invalid)
    with pytest.raises(HttpError):
        _cached_mvt(ApiSampleCollection, {}, 1, 0, 0)


def test_canonical_keys_and_timeout(configured_cache, settings, monkeypatch):
    key = tile_key(ApiSampleCollection, "7", {}, 0, 0, 0)
    assert key.startswith(f"samplesift:tile:{ApiSampleCollection.api_name()}:7:")
    assert key == tile_key(ApiSampleCollection, "7", {"filter": None, "limit": 5}, 0, 0, 0)
    assert tile_key(ApiSampleCollection, "7", {"filter": {"a": 1, "b": 2}}, 0, 0, 0) == tile_key(ApiSampleCollection, "7", {"filter": {"b": 2, "a": 1}}, 0, 0, 0)
    assert key != tile_key(ApiSampleCollection, "8", {}, 0, 0, 0)
    settings.SAMPLESIFT_CACHE_TIMEOUT = 42
    monkeypatch.setattr("samplesift.django.api._mvt", lambda *args: b"tile")
    setter = MagicMock(wraps=configured_cache.set)
    monkeypatch.setattr(configured_cache, "set", setter)
    _cached_mvt(ApiSampleCollection, {}, 0, 0, 0)
    assert setter.call_args.kwargs["timeout"] == 42


def test_warm_collection_batches_without_expiry(configured_cache, settings, monkeypatch):
    settings.SAMPLESIFT_CLUSTER_MAX_ZOOM = 1
    monkeypatch.setattr("samplesift.django.cache.WARM_BATCH_SIZE", 2)
    setter = MagicMock(wraps=configured_cache.set_many)
    monkeypatch.setattr(configured_cache, "set_many", setter)
    tiles = {0: [("1", 0, 0, b"a")], 1: [("1", 0, 0, b"b"), ("1", 1, 0, b"c"), ("1", 1, 1, b"d")]}
    assert warm_collection(ApiSampleCollection, lambda z: tiles[z]) == {0: 1, 1: 3}
    assert setter.call_count == 3
    assert all(call.kwargs["timeout"] is None for call in setter.call_args_list)
    monkeypatch.setattr("samplesift.django.api._mvt", MagicMock(side_effect=AssertionError))
    assert _cached_mvt(ApiSampleCollection, {"filter": None}, 1, 1, 1) == b"d"


def test_selected_alias(settings):
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "default"},
        "tiles": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "tiles"},
    }
    settings.SAMPLESIFT_CACHE_ALIAS = "tiles"
    assert tile_cache() is caches["tiles"]
