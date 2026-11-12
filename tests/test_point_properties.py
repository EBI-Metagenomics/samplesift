"""Point declarations resolve typed collection properties without database access."""

from decimal import Decimal
from typing import ClassVar

import pytest
from django.contrib.gis.db import models as gis_models
from django.contrib.gis.geos import Point as GEOSPoint
from django.db import models

from samplesift.django import Point, Property, SampleSiftCollection
from samplesift.django.models import CollectionDefinitionError
from samplesift.django.registry import CollectionRegistry


class MetadataSample(models.Model):
    metadata = models.JSONField(default=dict)
    stored_lon = models.FloatField(null=True)
    geometry = gis_models.PointField(null=True)

    class Meta:
        app_label = "samplesift_point_tests"


class MetadataCollection(SampleSiftCollection):
    lat = Property(models.FloatField(null=True))
    lon = Property(models.FloatField(null=True), attr="stored_lon")
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = MetadataSample

    class Query:
        default_ordering: ClassVar[list[str]] = ["lat"]

    @staticmethod
    def prepare_lat(sample: MetadataSample) -> float | None:
        value = sample.metadata.get("lat")
        return None if value is None else float(value)


def test_point_properties_register_and_resolve_json_metadata() -> None:
    registry = CollectionRegistry()
    registry.register(MetadataCollection)
    assert isinstance(
        registry.get_model(MetadataCollection)._meta.get_field("geometry"),
        gis_models.PointField,
    )
    sample = MetadataSample(metadata={"lat": "58.5"}, stored_lon=2)
    point = MetadataCollection.value_for(sample, "geometry")
    assert point.coords == (2, 58.5)
    assert point.srid == 4326
    assert point.y == MetadataCollection.value_for(sample, "lat")
    assert point.x == MetadataCollection.value_for(sample, "lon")


@pytest.mark.parametrize(
    "metadata, longitude", [({}, 2), ({"lat": None}, 2), ({"lat": 58}, None)]
)
def test_missing_property_coordinate_produces_null_geometry(
    metadata: dict, longitude: float | None
) -> None:
    sample = MetadataSample(metadata=metadata, stored_lon=longitude)
    assert MetadataCollection.value_for(sample, "geometry") is None


def test_numeric_properties_use_prepare_before_attr() -> None:
    class PreparedCollection(MetadataCollection):
        lon = Property(
            models.DecimalField(max_digits=8, decimal_places=4), attr="stored_lon"
        )

        @staticmethod
        def prepare_lon(sample: MetadataSample) -> Decimal:
            return Decimal(sample.metadata["lon"])

    PreparedCollection.collection_fields()
    point = PreparedCollection.value_for(
        MetadataSample(metadata={"lat": 0, "lon": "0"}, stored_lon=99), "geometry"
    )
    assert point.coords == (0, 0)


@pytest.mark.parametrize(
    "field",
    [models.CharField(max_length=20), models.JSONField(), gis_models.PointField()],
)
def test_point_rejects_nonnumeric_coordinate_properties(field: models.Field) -> None:
    class InvalidCollection(MetadataCollection):
        lat = Property(field)

    with pytest.raises(CollectionDefinitionError, match="must be numeric"):
        InvalidCollection.collection_fields()


def test_point_rejects_unknown_coordinate_names() -> None:
    class InvalidCollection(MetadataCollection):
        geometry = Point(longitude="missing", latitude="lat")

    with pytest.raises(CollectionDefinitionError, match="unknown field 'missing'"):
        InvalidCollection.collection_fields()


def test_point_field_property_uses_preparation_and_clones_geometry() -> None:
    class PreparedPointCollection(MetadataCollection):
        location = Property(gis_models.PointField(null=True))
        geometry = Point(field="location")

        @staticmethod
        def prepare_location(sample: MetadataSample) -> GEOSPoint | None:
            return sample.geometry

    assert PreparedPointCollection.geometry_field().null
    original = GEOSPoint(222638.98158654713, 0, srid=3857)
    point = PreparedPointCollection.value_for(
        MetadataSample(geometry=original), "geometry"
    )
    assert point.x == pytest.approx(2)
    assert point.srid == 4326
    assert original.srid == 3857
    assert (
        PreparedPointCollection.value_for(MetadataSample(geometry=None), "geometry")
        is None
    )


def test_source_point_named_geometry_does_not_recurse() -> None:
    class SourcePointCollection(SampleSiftCollection):
        geometry = Point(field="geometry")

        class Meta:
            model = MetadataSample

    SourcePointCollection.collection_fields()
    original = GEOSPoint(2, 58, srid=4326)
    point = SourcePointCollection.value_for(
        MetadataSample(geometry=original), "geometry"
    )
    assert point.equals(original)
    assert point is not original
