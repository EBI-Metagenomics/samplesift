"""Collection registry and synchronous source-model synchronisation."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import connections, models, transaction
from django.db.models.signals import post_delete, post_save

from .models import SampleSiftCollection

logger = logging.getLogger(__name__)


class CollectionRegistry:
    def __init__(self) -> None:
        self._collections: list[type[SampleSiftCollection]] = []
        self._models: dict[type[SampleSiftCollection], type[models.Model]] = {}
        self._table_names: dict[str, type[SampleSiftCollection]] = {}
        self._api_names: dict[str, type[SampleSiftCollection]] = {}
        self._api_registration_callback: Callable[[type[SampleSiftCollection]], None] | None = None
        self._api_frozen = False

    def register(
        self, collection: type[SampleSiftCollection]
    ) -> type[SampleSiftCollection]:
        if not issubclass(collection, SampleSiftCollection):
            raise TypeError("Only SampleSiftCollection subclasses can be registered.")
        if collection in self._collections:
            return collection
        if collection.geometry is not None and self._api_frozen:
            raise RuntimeError(
                "SampleSift API routes are frozen; register spatial collections during Django startup."
            )
        collection.source_model()
        collection.source_database()
        collection.collection_fields()
        table_name = collection.table_name()
        if table_name in self._table_names:
            raise ValueError(
                f"A collection already uses table {table_name!r}; set Meta.table_name to override it."
            )
        api_name: str | None = None
        if collection.geometry is not None:
            api_name = collection.api_name()
            collection.default_ordering()
            if api_name in self._api_names:
                raise ValueError(f"A collection is already registered as {api_name!r}.")
        self._collections.append(collection)
        self._table_names[table_name] = collection
        if api_name is not None:
            self._api_names[api_name] = collection
            if self._api_registration_callback is not None:
                self._api_registration_callback(collection)
        self.get_model(collection)
        self._connect_signals(collection)
        return collection

    @property
    def collections(self) -> tuple[type[SampleSiftCollection], ...]:
        return tuple(self._collections)

    def target_database(self) -> str:
        alias = getattr(settings, "SAMPLESIFT_DATABASE_ALIAS", "default")
        if connections[alias].vendor != "postgresql":
            raise ImproperlyConfigured(
                f"SampleSift requires PostgreSQL/PostGIS; database {alias!r} is not PostgreSQL."
            )
        return alias

    def get_collection(self, api_name: str) -> type[SampleSiftCollection]:
        try:
            return self._api_names[api_name]
        except KeyError as error:
            raise KeyError(f"Unknown SampleSift collection {api_name!r}.") from error

    @property
    def api_collections(self) -> tuple[type[SampleSiftCollection], ...]:
        """Registered collections that have opted into the spatial query API."""
        return tuple(self._api_names.values())

    def set_api_registration_callback(
        self, callback: Callable[[type[SampleSiftCollection]], None]
    ) -> None:
        self._api_registration_callback = callback

    def freeze_api(self) -> None:
        self._api_frozen = True

    def get_model(self, collection: type[SampleSiftCollection]) -> type[models.Model]:
        if collection not in self._models:
            attributes: dict[str, Any] = {
                "__module__": collection.__module__,
                "source_pk": models.CharField(max_length=255, primary_key=True),
            }
            attributes.update(collection.collection_fields())
            meta_attributes: dict[str, Any] = {
                "app_label": "samplesift_django",
                "db_table": collection.table_name(),
                "managed": False,
            }
            if "geometry" in attributes:
                from django.contrib.postgres.indexes import GistIndex

                meta_attributes["indexes"] = [GistIndex(fields=["geometry"])]
            attributes["Meta"] = type(
                "Meta",
                (),
                meta_attributes,
            )
            self._models[collection] = type(
                f"{collection.__name__}Row", (models.Model,), attributes
            )
        return self._models[collection]

    def _connect_signals(self, collection: type[SampleSiftCollection]) -> None:
        source = collection.source_model()

        def save_receiver(
            sender: type[models.Model], instance: models.Model, using: str, raw: bool, **_: Any
        ) -> None:
            if raw or using != collection.source_database():
                return
            transaction.on_commit(
                lambda: self._run_sync(collection, str(instance.pk), deleted=False), using=using
            )

        def delete_receiver(
            sender: type[models.Model], instance: models.Model, using: str, **_: Any
        ) -> None:
            if using != collection.source_database():
                return
            transaction.on_commit(
                lambda: self._run_sync(collection, str(instance.pk), deleted=True), using=using
            )

        post_save.connect(
            save_receiver,
            sender=source,
            weak=False,
            dispatch_uid=f"samplesift.save.{collection.__module__}.{collection.__qualname__}",
        )
        post_delete.connect(
            delete_receiver,
            sender=source,
            weak=False,
            dispatch_uid=f"samplesift.delete.{collection.__module__}.{collection.__qualname__}",
        )

    def _run_sync(
        self, collection: type[SampleSiftCollection], source_pk: str, *, deleted: bool
    ) -> None:
        try:
            if deleted:
                self._delete_collection(collection, source_pk)
            else:
                self._sync_saved(collection, source_pk)
        except Exception:
            logger.exception(
                "SampleSift collection sync failed",
                extra={
                    "collection": collection.__qualname__,
                    "source_model": collection.source_model()._meta.label,
                    "source_pk": source_pk,
                    "operation": "delete" if deleted else "upsert",
                },
            )
            raise

    def _sync_saved(self, collection: type[SampleSiftCollection], source_pk: str) -> None:
        source = collection.source_model()
        instance = source._default_manager.using(collection.source_database()).filter(
            pk=source_pk
        ).first()
        if instance is None:
            self._delete_collection(collection, source_pk)
            return
        values = {
            name: collection.value_for(instance, name)
            for name in collection.collection_fields()
        }
        self.get_model(collection)._default_manager.using(self.target_database()).update_or_create(
            source_pk=source_pk,
            defaults=values,
        )

    def _delete_collection(self, collection: type[SampleSiftCollection], source_pk: str) -> None:
        self.get_model(collection)._default_manager.using(self.target_database()).filter(
            source_pk=source_pk
        ).delete()


registry = CollectionRegistry()
