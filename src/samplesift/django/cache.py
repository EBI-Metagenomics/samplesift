"""Collection-scoped vector tile caching."""

import hashlib
import json
from typing import Any

from django.conf import settings
from django.core.cache import caches
from django.db import ProgrammingError, connections

from .config import get_settings

VERSION_TABLE = "samplesift_collection_version"
VERSION_TRIGGER = "samplesift_version"
VERSION_FUNCTION = "samplesift_touch_version"
# Epoch microseconds keep the version exact, compact, and readable in keys.
VERSION_SQL = f"(extract(epoch FROM synced_at) * 1000000)::bigint::text FROM {VERSION_TABLE} WHERE table_name = %s"
WARM_BATCH_SIZE = 500


def tile_cache():
    """Select the host's cache, or disable caching when none was configured."""
    alias = getattr(settings, "SAMPLESIFT_CACHE_ALIAS", None)
    if alias is None:
        # Django provides an implicit local-memory default even without CACHES.
        # Only opt into that default when the host explicitly configured it.
        if not settings.is_overridden("CACHES"):
            return None
        alias = "default"
    return caches[alias]


def version_ddl(table_name: str) -> list[tuple[str, list[str]]]:
    """Statements installing the write-timestamp version for one collection table.

    A statement-level trigger records every write, including raw SQL and bulk
    loads, in the same transaction as the write itself.
    """
    return [
        (f"CREATE TABLE IF NOT EXISTS {VERSION_TABLE} (table_name text PRIMARY KEY, synced_at timestamptz NOT NULL)", []),
        (f"""CREATE OR REPLACE FUNCTION {VERSION_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO {VERSION_TABLE} (table_name, synced_at) VALUES (TG_TABLE_NAME, clock_timestamp())
            ON CONFLICT (table_name) DO UPDATE SET synced_at = clock_timestamp();
            RETURN NULL;
        END $$""", []),
        (
            (
                f'CREATE OR REPLACE TRIGGER {VERSION_TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE '
                f'ON "{table_name}" FOR EACH STATEMENT EXECUTE FUNCTION {VERSION_FUNCTION}()'
            ),
            [],
        ),
        # Tables populated before the trigger existed still need a version.
        (
            (
                f"INSERT INTO {VERSION_TABLE} (table_name, synced_at) VALUES (%s, clock_timestamp()) "
                "ON CONFLICT (table_name) DO NOTHING"
            ),
            [table_name],
        ),
    ]


def collection_version(collection, using: str) -> str | None:
    """Return the collection's last-write timestamp, or None before schema sync."""
    try:
        with connections[using].cursor() as cursor:
            cursor.execute("SELECT " + VERSION_SQL, [collection.table_name()])
            row = cursor.fetchone()
    except ProgrammingError:
        # The version table does not exist yet. Callers are never inside an
        # atomic block, so the failed statement leaves no aborted transaction.
        return None
    return row[0] if row else None


def tile_key(collection, version: str, payload: dict[str, Any], z: int, x: int, y: int) -> str:
    """Build a key from the collection version and every input that changes tile bytes."""
    config = get_settings()
    # Only the filter affects tiles; {} and {"filter": null} therefore share a key.
    # Sorting JSON object keys makes equivalent filters independent of property order.
    data = [collection.table_name(), z, x, y, config.cluster_radius_pixels,
            config.cluster_max_zoom, payload.get("filter")]
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
    return f"samplesift:tile:{collection.api_name()}:{version}:{digest}"


def warm_collection(collection, tiles) -> dict[int, int]:
    """Store every non-empty empty-filter tile through the clustered zooms.

    ``tiles(z)`` yields ``(version, x, y, bytes)``. Prewarmed tiles never expire:
    a later write changes the version, which makes them unreachable.
    """
    cache = tile_cache()
    counts: dict[int, int] = {}
    for z in range(get_settings().cluster_max_zoom + 1):
        batch: dict[str, bytes] = {}
        counts[z] = 0
        for version, x, y, tile in tiles(z):
            batch[tile_key(collection, version, {}, z, x, y)] = tile
            if len(batch) >= WARM_BATCH_SIZE:
                cache.set_many(batch, timeout=None)
                counts[z] += len(batch)
                batch = {}
        if batch:
            cache.set_many(batch, timeout=None)
            counts[z] += len(batch)
    return counts
