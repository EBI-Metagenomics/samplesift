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
