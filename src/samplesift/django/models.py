"""Declarative collection definitions for the Django integration."""

from __future__ import annotations

import re
from typing import Any, ClassVar

from django.db import models

from .constants import WGS84_SRID


class CollectionDefinitionError(ValueError):
    """Raised when a collection declaration cannot be materialised."""


def _unkeyed_clone(field: models.Field) -> models.Field:
    """Clone ``field`` without primary key or unique constraints."""
    # Rebuild like Field.clone(); Django 5.0 has no `unique` setter.
    _, _, args, kwargs = field.deconstruct()
    kwargs.update(primary_key=False, unique=False)
    return field.__class__(*args, **kwargs)


class Property:
    """A typed value copied from, or computed from, a source instance.

    ``attr`` uses Django-style double-underscore traversal.  A declaration method
    named ``prepare_<property name>`` takes precedence over it.
    """

    def __init__(self, field: models.Field[Any, Any], *, attr: str | None = None) -> None:
        self.field = field
        self.attr = attr
        self.name: str | None = None

    def __set_name__(self, owner: type[SampleSiftCollection], name: str) -> None:
        self.name = name


class Point:
    """A WGS84 point resolved from source fields or typed collection properties."""

    def __init__(
        self,
        *,
        field: str | None = None,
        longitude: str | None = None,
        latitude: str | None = None,
    ) -> None:
        if (field is None) == (longitude is None or latitude is None):
            raise CollectionDefinitionError(
                "Point needs field= or both longitude= and latitude=."
            )
        self.field = field
        self.longitude = longitude
        self.latitude = latitude


class SampleSiftCollection:
    """Base class for a registered SampleSift collection declaration.

    This is intentionally not a Django ``models.Model``.  The registry builds a
    real model for each declaration so its table can be queried with Django while
    remaining outside the host application's migration graph.
    """

    fields: ClassVar[list[str]] = []
    geometry: ClassVar[Point | None] = None

    @classmethod
    def source_model(cls) -> type[models.Model]:
        meta = getattr(cls, "Meta", None)
        model = getattr(meta, "model", None)
        if not isinstance(model, type) or not issubclass(model, models.Model):
            raise CollectionDefinitionError(
                f"{cls.__name__}.Meta.model must be a Django model class."
            )
        return model

    @classmethod
    def source_database(cls) -> str:
        meta = getattr(cls, "Meta", None)
        database = getattr(meta, "database", "default")
        if not isinstance(database, str) or not database:
            raise CollectionDefinitionError(
                f"{cls.__name__}.Meta.database must be a non-empty database alias."
            )
        return database

    @classmethod
    def properties(cls) -> dict[str, Property]:
        declared: dict[str, Property] = {}
        for base in reversed(cls.__mro__):
            for name, value in vars(base).items():
                if isinstance(value, Property):
                    declared[name] = value
        return declared

    @classmethod
    def table_name(cls) -> str:
        meta = getattr(cls, "Meta", None)
        configured_name = getattr(meta, "table_name", None)
        if configured_name is not None:
            if not isinstance(configured_name, str) or not re.fullmatch(
                r"[a-z][a-z0-9_]*", configured_name
            ):
                raise CollectionDefinitionError(
                    f"{cls.__name__}.Meta.table_name must be a lowercase SQL identifier."
                )
            return configured_name
        source_name = cls.source_model().__name__
        words = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", source_name)
        words = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", words).lower()
        return f"samplesift_{words}_collection"

    @classmethod
    def api_name(cls) -> str:
        meta = getattr(cls, "Meta", None)
        name = getattr(meta, "api_name", None)
        if name is None:
            source_name = cls.source_model().__name__
            name = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", source_name)
            name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1-\2", name)
            name = name.replace("_", "-").lower()
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", name):
            raise CollectionDefinitionError(
                f"{cls.__name__}.Meta.api_name must be a lowercase slug when set."
            )
        return name

    @classmethod
    def default_ordering(cls) -> list[str]:
        query = getattr(cls, "Query", None)
        ordering = getattr(query, "default_ordering", None)
        if not isinstance(ordering, list) or not ordering or not all(
            isinstance(value, str) and value.lstrip("-") for value in ordering
        ):
            raise CollectionDefinitionError(
                f"{cls.__name__}.Query.default_ordering must be a non-empty list."
            )
        fields = cls.collection_fields()
        for value in ordering:
            name = value.removeprefix("-")
            if name not in fields or name == "geometry":
                raise CollectionDefinitionError(
                    f"{cls.__name__}.Query.default_ordering includes unknown field {name!r}."
                )
        return ordering

    @classmethod
    def geometry_field(cls) -> models.Field[Any, Any]:
        from django.contrib.gis.db import models as gis_models

        declaration = cls.geometry
        if not isinstance(declaration, Point):
            raise CollectionDefinitionError(
                f"{cls.__name__}.geometry must be a Point declaration."
            )
        source = cls.source_model()
        properties = cls.properties()
        names = (
            (declaration.field,)
            if declaration.field is not None
            else (declaration.longitude, declaration.latitude)
        )
        for name in names:
            assert name is not None
            if name in properties:
                source_field = properties[name].field
            else:
                try:
                    source_field = source._meta.get_field(name)
                except Exception as error:
                    raise CollectionDefinitionError(
                        f"{cls.__name__}.geometry references unknown field {name!r}."
                    ) from error
            if declaration.field is not None:
                if not isinstance(source_field, gis_models.PointField):
                    raise CollectionDefinitionError(
                        "Point field= must reference a GeoDjango PointField."
                    )
                return gis_models.PointField(srid=WGS84_SRID, null=source_field.null)
            if not isinstance(
                source_field,
                (models.IntegerField, models.FloatField, models.DecimalField),
            ):
                raise CollectionDefinitionError(
                    "Point longitude/latitude fields must be numeric."
                )
        return gis_models.PointField(srid=WGS84_SRID, null=True)

    @classmethod
    def collection_fields(cls) -> dict[str, models.Field[Any, Any]]:
        source = cls.source_model()
        selected = cls.fields
        if not isinstance(selected, list) or not all(
            isinstance(name, str) for name in selected
        ):
            raise CollectionDefinitionError(f"{cls.__name__}.fields must be a list of names.")

        result: dict[str, models.Field[Any, Any]] = {}
        for name in selected:
            if name == "source_pk" or name in result:
                raise CollectionDefinitionError(
                    f"{cls.__name__}.fields contains duplicate or reserved field {name!r}."
                )
            try:
                source_field = source._meta.get_field(name)
            except Exception as error:
                raise CollectionDefinitionError(
                    f"{cls.__name__}.fields includes unknown field {name!r}."
                ) from error

            if (
                source_field.many_to_many
                or source_field.auto_created
                or getattr(source_field, "generated", False)
            ):
                raise CollectionDefinitionError(
                    f"{cls.__name__}.fields cannot include relation {name!r}."
                )
            if source_field.is_relation and not isinstance(source_field, models.ForeignKey):
                raise CollectionDefinitionError(
                    f"{cls.__name__}.fields only supports scalar fields and foreign keys."
                )
            field_to_copy = (
                source_field.target_field
                if isinstance(source_field, models.ForeignKey)
                else source_field
            )
            if isinstance(field_to_copy, models.AutoField):
                field = models.BigIntegerField(null=field_to_copy.null)
            else:
                field = _unkeyed_clone(field_to_copy)
            # Collection writes must preserve source timestamps rather than let
            # Django's auto_now/auto_now_add hooks manufacture new values.
            if hasattr(field, "auto_now"):
                field.auto_now = False
            if hasattr(field, "auto_now_add"):
                field.auto_now_add = False
            result[name] = field

        for name, declaration in cls.properties().items():
            if name in result or name == "source_pk":
                raise CollectionDefinitionError(
                    f"{cls.__name__} declares duplicate or reserved property {name!r}."
                )
            if not isinstance(declaration.field, models.Field):
                raise CollectionDefinitionError(f"Property {name!r} requires a Django field.")
            field = _unkeyed_clone(declaration.field)
            result[name] = field
        if cls.geometry is not None:
            if "geometry" in result:
                raise CollectionDefinitionError("geometry is reserved for the Point declaration.")
            result["geometry"] = cls.geometry_field()
        return result

    @classmethod
    def value_for(cls, instance: models.Model, name: str) -> Any:
        if name == "geometry" and cls.geometry is not None:
            declaration = cls.geometry
            if declaration.field is not None:
                value = cls._value_for_field(instance, declaration.field)
                if value is None:
                    return None
                value = value.clone()
                if value.srid != WGS84_SRID:
                    value.transform(WGS84_SRID)
                return value
            assert (
                declaration.longitude is not None and declaration.latitude is not None
            )
            longitude = cls._value_for_field(instance, declaration.longitude)
            latitude = cls._value_for_field(instance, declaration.latitude)
            if longitude is None or latitude is None:
                return None
            from django.contrib.gis.geos import Point as GEOSPoint

            return GEOSPoint(float(longitude), float(latitude), srid=WGS84_SRID)
        return cls._value_for_field(instance, name)

    @classmethod
    def _value_for_field(cls, instance: models.Model, name: str) -> Any:
        """Resolve a source field or property without entering geometry assembly."""
        property_declaration = cls.properties().get(name)
        if property_declaration is None:
            source_field = cls.source_model()._meta.get_field(name)
            return getattr(
                instance, source_field.attname if source_field.is_relation else name
            )

        prepare = getattr(cls, f"prepare_{name}", None)
        if prepare is not None:
            return prepare(instance)
        if property_declaration.attr is None:
            raise CollectionDefinitionError(
                f"Property {cls.__name__}.{name} needs attr= or prepare_{name}()."
            )
        value: Any = instance
        for part in property_declaration.attr.split("__"):
            if value is None:
                return None
            value = getattr(value, part)
        return value
