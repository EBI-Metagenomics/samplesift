"""Synchronise collection rows from their authoritative source models."""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import connections

from ...registry import registry


class Command(BaseCommand):
    """Refresh one named collection or every registered collection."""

    help = "Synchronise collection content from source rows and remove orphaned collection rows."

    def add_arguments(self, parser: CommandParser) -> None:
        """Accept an optional collection API name."""
        parser.add_argument(
            "collection",
            nargs="?",
            help="Collection API name; defaults to all collections.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        """Validate storage before synchronising the selected collections."""
        collections = registry.collections
        name = options["collection"]
        if name is not None:
            collections = tuple(
                collection
                for collection in collections
                if collection.api_name() == name
            )
            if not collections:
                raise CommandError(f"Unknown SampleSift collection {name!r}.")
            if len(collections) > 1:
                raise CommandError(
                    f"Ambiguous collection {name!r}; set unique Meta.api_name values."
                )
        if not collections:
            self.stdout.write("No SampleSift collections registered.")
            return

        try:
            alias = registry.target_database()
        except ImproperlyConfigured as error:
            raise CommandError(str(error)) from error
        tables = set(connections[alias].introspection.table_names())
        missing = sorted(
            collection.table_name()
            for collection in collections
            if collection.table_name() not in tables
        )
        if missing:
            raise CommandError(
                f"Missing collection tables in database {alias!r}: {', '.join(missing)}. "
                "Run python manage.py samplesift_sync_schema first."
            )

        for collection in collections:
            source_ids = set()
            source = collection.source_model()._default_manager.using(
                collection.source_database()
            )
            for pk in source.values_list("pk", flat=True).iterator():
                source_pk = str(pk)
                source_ids.add(source_pk)
                registry._sync_saved(collection, source_pk)

            rows = registry.get_model(collection)._default_manager.using(alias)
            removed = 0
            for source_pk in rows.values_list("source_pk", flat=True).iterator():
                if source_pk not in source_ids:
                    registry._delete_collection(collection, source_pk)
                    removed += 1
            self.stdout.write(
                f"Synced {collection.api_name()}: {len(source_ids)} source rows; "
                f"removed {removed} orphaned rows."
            )
