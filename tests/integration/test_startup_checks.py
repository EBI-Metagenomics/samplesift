"""Fresh storage remains repairable through the schema management command."""

from typing import ClassVar

import pytest
from django.core.management import call_command
from django.db import connections, models

from samplesift.django import SampleSiftCollection, checks
from samplesift.django.registry import CollectionRegistry


class StartupSample(models.Model):
    label = models.CharField(max_length=20)

    class Meta:
        app_label = "samplesift_startup_tests"


class StartupCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["label"]

    class Meta:
        model = StartupSample


@pytest.mark.django_db(transaction=True)
def test_missing_table_check_recovers_after_schema_setup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = CollectionRegistry()
    registry.register(StartupCollection)
    monkeypatch.setattr(checks, "registry", registry)
    monkeypatch.setattr(
        "samplesift.django.management.commands.samplesift_sync_schema.registry",
        registry,
    )
    (error,) = checks.check_collection_tables()
    assert error.id == "samplesift.E001"
    assert StartupCollection.table_name() in error.msg
    model = registry.get_model(StartupCollection)
    try:
        call_command("samplesift_sync_schema", skip_checks=False, no_warm_cache=True)
        assert checks.check_collection_tables() == []
    finally:
        connection = connections[registry.target_database()]
        if model._meta.db_table in connection.introspection.table_names():
            with connection.schema_editor() as editor:
                editor.delete_model(model)
