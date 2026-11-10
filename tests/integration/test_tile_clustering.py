from typing import ClassVar

import pytest
from django.db import connection, models

from samplesift.django import Point, SampleSiftCollection
from samplesift.django.api import _mvt
from samplesift.django.registry import CollectionRegistry

pytestmark = pytest.mark.skipif(connection.vendor != "postgresql", reason="Requires PostGIS")


@pytest.mark.django_db(transaction=True)
def test_distance_clusters_cross_tile_boundaries_and_respect_filters() -> None:
    class Source(models.Model):
        lon = models.FloatField()
        lat = models.FloatField()
        label = models.CharField(max_length=30)

        class Meta:
            app_label = "samplesift_tile_tests"

    class Collection(SampleSiftCollection):
        fields: ClassVar[list[str]] = ["label"]
        geometry = Point(longitude="lon", latitude="lat")

        class Meta:
            model = Source

        class Query:
            default_ordering: ClassVar[list[str]] = ["label"]

    from django.contrib.gis.geos import Point as GeoPoint

    local = CollectionRegistry()
    local.register(Collection)
    model = local.get_model(Collection)
    with connection.schema_editor() as editor:
        editor.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        editor.create_model(model)
    try:
        model.objects.bulk_create([
            model(source_pk="a", label="keep", geometry=GeoPoint(-0.01, 10, srid=4326)),
            model(source_pk="b", label="keep", geometry=GeoPoint(0.02, 10, srid=4326)),
            model(source_pk="c", label="remove", geometry=GeoPoint(0.03, 10, srid=4326)),
        ])

        def features(query, x):
            captured = []

            def capture(execute, sql, params, many, context):
                captured.append((sql, params))
                return execute(sql, params, many, context)

            with connection.execute_wrapper(capture):
                _mvt(Collection, query, 2, x, 1)
            sql, params = captured[-1]
            sql = sql.replace(
                "COALESCE(ST_AsMVT(tile, %s, 4096, 'geom'), ''::bytea)",
                "COALESCE(json_agg(row_to_json(tile)) FILTER (WHERE geom IS NOT NULL), '[]'::json)",
            )
            with connection.cursor() as cursor:
                cursor.execute(sql, [*params[:-4], *params[-3:]])
                return cursor.fetchone()[0]

        query = model.objects.filter(label="keep")
        # The shared cluster's centroid belongs to the eastern tile.
        west, east = features(query, 1), features(query, 2)
        assert west == []
        assert east[0]["point_count"] == 2
        assert east[0]["cluster"] is True
        single = features(model.objects.filter(source_pk="b"), 2)
        assert single[0]["point_count"] == 1
        assert single[0]["label"] == "keep"
    finally:
        with connection.schema_editor() as editor:
            editor.delete_model(model)
