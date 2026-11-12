"""Check collection storage before serving requests."""

from __future__ import annotations

import sys
from typing import Any

from django.core.checks import Error, Tags, register
from django.core.exceptions import ImproperlyConfigured
from django.db import DatabaseError, connections
from django.utils.connection import ConnectionDoesNotExist

from .registry import registry


@register(Tags.database, deploy=True)
def check_collection_tables(**kwargs: Any) -> list[Error]:
    """Report missing collection tables during deployment checks.

    :return: Database configuration, connection, or missing-table errors.
    """
    if not registry.collections:
        return []
    alias = ""
    try:
        alias = registry.target_database()
        tables = set(connections[alias].introspection.table_names())
    except (DatabaseError, ImproperlyConfigured, ConnectionDoesNotExist) as error:
        return [
            Error(
                f"SampleSift could not inspect collection storage: {error}",
                hint="Check DATABASES and SAMPLESIFT_DATABASE_ALIAS, then run python manage.py samplesift_sync_schema.",
                obj=f"database {alias!r}" if alias else None,
                id="samplesift.E002",
            )
        ]
    missing = sorted(
        {collection.table_name() for collection in registry.collections} - tables
    )
    if not missing:
        return []
    return [
        Error(
            "SampleSift collection tables are missing: " + ", ".join(missing),
            hint="Run python manage.py samplesift_sync_schema before starting the server.",
            obj=f"database {alias!r}",
            id="samplesift.E001",
        )
    ]


@register(Tags.database)
def check_runserver_collection_tables(**kwargs: Any) -> list[Error]:
    """Check development startup without blocking schema setup commands.

    :return: Collection storage errors for a runserver invocation.
    """
    # Django also runs system checks before migrations and other setup commands.
    if len(sys.argv) < 2 or sys.argv[1] != "runserver":
        return []
    return check_collection_tables(**kwargs)
