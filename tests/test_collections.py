from __future__ import annotations

from typing import ClassVar

import pytest
from django.db import connections, models, transaction

from samplesift.django import Property, SampleSiftCollection, registry
from samplesift.django.registry import CollectionRegistry


class Sample(models.Model):
    lat = models.FloatField()
    lon = models.FloatField()
    temperature = models.FloatField()
    species_name = models.CharField(max_length=255)

    class Meta:
        app_label = "samplesift_tests"


class SampleCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["lat", "lon", "temperature", "species_name"]
    species_name_upper = Property(models.CharField(max_length=255))

    class Meta:
        model = Sample

    @staticmethod
    def prepare_species_name_upper(sample: Sample) -> str:
        return sample.species_name.upper()


registry.register(SampleCollection)


def test_collection_table_name_defaults_to_source_model_name() -> None:
    assert SampleCollection.table_name() == "samplesift_sample_collection"


def test_collection_registry_rejects_duplicate_generated_table_names() -> None:
    isolated_registry = CollectionRegistry()

    class TableNameSample(models.Model):
        class Meta:
            app_label = "samplesift_collection_tests"

    class FirstCollection(SampleSiftCollection):
        class Meta:
            model = TableNameSample

    class SecondCollection(SampleSiftCollection):
        class Meta:
            model = TableNameSample

    isolated_registry.register(FirstCollection)
    with pytest.raises(ValueError, match="Meta.table_name"):
        isolated_registry.register(SecondCollection)


@pytest.fixture(scope="module", autouse=True)
def collection_tables(django_db_setup: object, django_db_blocker: object) -> None:
    collection_model = registry.get_model(SampleCollection)
    with django_db_blocker.unblock():
        with connections["default"].schema_editor() as editor:
            editor.create_model(Sample)
        for alias in ("default", "samplesift"):
            with connections[alias].schema_editor() as editor:
                editor.create_model(collection_model)
    yield
    with django_db_blocker.unblock():
        for alias in ("default", "samplesift"):
            with connections[alias].schema_editor() as editor:
                editor.delete_model(collection_model)
        with connections["default"].schema_editor() as editor:
            editor.delete_model(Sample)


@pytest.fixture(params=["default", "samplesift"])
def target_alias(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    # Exercise synchronization on SQLite independently of target backend validation.
    alias = request.param
    monkeypatch.setattr(registry, "target_database", lambda: alias)
    return alias


@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_sample_collection_syncs_selected_fields_and_custom_property(target_alias: str) -> None:
    sample = Sample.objects.create(
        lat=41.3851,
        lon=2.1734,
        temperature=23.5,
        species_name="quercus ilex",
    )

    row = registry.get_model(SampleCollection).objects.using(target_alias).get(
        source_pk=str(sample.pk)
    )

    assert (row.lat, row.lon, row.temperature) == (41.3851, 2.1734, 23.5)
    assert row.species_name == "quercus ilex"
    assert row.species_name_upper == "QUERCUS ILEX"


@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_sample_collection_updates_and_deletes_after_source_changes(target_alias: str) -> None:
    sample = Sample.objects.create(
        lat=1,
        lon=2,
        temperature=3,
        species_name="acer",
    )
    sample.temperature = 4
    sample.save()

    collection_model = registry.get_model(SampleCollection)
    assert collection_model.objects.using(target_alias).get(
        source_pk=str(sample.pk)
    ).temperature == 4

    sample.delete()

    assert not collection_model.objects.using(target_alias).filter(
        source_pk=str(sample.pk)
    ).exists()


@pytest.mark.django_db(databases=["default", "samplesift"], transaction=True)
def test_rolled_back_source_write_is_not_materialised(target_alias: str) -> None:
    with pytest.raises(RuntimeError), transaction.atomic():
        sample = Sample.objects.create(
            lat=1,
            lon=2,
            temperature=3,
            species_name="rollback",
        )
        source_pk = str(sample.pk)
        raise RuntimeError("abort source transaction")

    assert not registry.get_model(SampleCollection).objects.using(target_alias).filter(
        source_pk=source_pk
    ).exists()
