"""Create and validate runtime SampleSift collection tables."""

from __future__ import annotations

from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import BaseCommand, CommandError
from django.db import connections

from ...registry import registry


class Command(BaseCommand):
    help = "Create missing SampleSift collection tables and report schema drift."

    def handle(self, *args: object, **options: object) -> None:
        try:
            alias = registry.target_database()
        except ImproperlyConfigured as error:
            raise CommandError(str(error)) from error
        connection = connections[alias]

        with connection.schema_editor() as editor:
            editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            tables = set(connection.introspection.table_names())
            for collection in registry.collections:
                model = registry.get_model(collection)
                if model._meta.db_table not in tables:
                    editor.create_model(model)
                    self.stdout.write(f"Created {model._meta.db_table}")
                    continue
                drift = self._drift(connection, model)
                if drift:
                    raise CommandError(
                        f"Schema drift for {model._meta.db_table}: " + "; ".join(drift)
                    )

    def _drift(self, connection: object, model: object) -> list[str]:
        # The command only accepts PostgreSQL above; Django's standard
        # introspection interface gives a portable enough type/nullability check.
        description = connection.introspection.get_table_description(  # type: ignore[attr-defined]
            connection.cursor(), model._meta.db_table  # type: ignore[attr-defined]
        )
        actual = {column.name: column for column in description}
        expected = {field.column: field for field in model._meta.local_fields}  # type: ignore[attr-defined]
        messages = [f"missing column {name}" for name in expected.keys() - actual.keys()]
        messages.extend(f"unexpected column {name}" for name in actual.keys() - expected.keys())
        for name in expected.keys() & actual.keys():
            actual_type = connection.introspection.get_field_type(  # type: ignore[attr-defined]
                actual[name].type_code, actual[name]
            )
            expected_type = expected[name].get_internal_type()
            if actual_type == "GeometryField" and expected_type == "PointField":
                # PostgreSQL reports all PostGIS geometry subtypes under one OID.
                # The typmod retains the subtype and SRID needed to validate it.
                with connection.cursor() as cursor:  # type: ignore[attr-defined]
                    cursor.execute(
                        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
                        "WHERE attrelid = %s::regclass AND attname = %s AND NOT attisdropped",
                        [model._meta.db_table, name],  # type: ignore[attr-defined]
                    )
                    row = cursor.fetchone()
                if row and row[0].lower() == expected[name].db_type(connection).lower():
                    actual_type = expected_type
            if actual_type != expected_type:
                messages.append(f"column {name} has type {actual_type}, expected {expected_type}")
            if actual[name].null_ok != expected[name].null:
                messages.append(f"column {name} has incompatible nullability")
        return messages
