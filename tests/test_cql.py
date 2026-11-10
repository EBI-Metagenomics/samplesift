import pytest
from django.db import connection, models

from samplesift.django.filters import compile_filter
from samplesift.query import Queryable


class FilterRow(models.Model):
    value = models.IntegerField(null=True)

    class Meta:
        app_label = "samplesift_api_tests"


DESCRIPTORS = {"score": (Queryable("score", {"type": "integer"}, ("=", "<>", ">", "in", "isNull")), "value")}
SPATIAL = {"geometry": (Queryable("geometry", {"type": "object"}, ("s_intersects",)), "geometry")}
POLYGON = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}


def spatial(geometry: dict) -> dict:
    return {"op": "s_intersects", "args": [{"property": "geometry"}, geometry]}


def test_spatial_filter_compiles_and_preserves_null_semantics() -> None:
    query = compile_filter({"op": "not", "args": [spatial(POLYGON)]}, SPATIAL)
    assert "geometry__isnull" in str(query)
    assert "geometry__intersects" in str(query)


@pytest.mark.parametrize("geometry", [
    {"type": "Point", "coordinates": [0, 0]},
    {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1]]]},
    {"type": "Polygon", "coordinates": [[[0, 0], [181, 0], [1, 1], [0, 0]]]},
    {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]},
])
def test_invalid_spatial_literals_are_rejected(geometry: dict) -> None:
    with pytest.raises(ValueError):
        compile_filter(spatial(geometry), SPATIAL)


@pytest.mark.django_db(transaction=True)
def test_nested_cql_respects_nulls() -> None:
    with connection.schema_editor() as editor:
        editor.create_model(FilterRow)
    try:
        FilterRow.objects.bulk_create([FilterRow(value=None), FilterRow(value=1), FilterRow(value=2)])
        expression = {"op": "not", "args": [{"op": "=", "args": [{"property": "score"}, 1]}]}
        assert list(FilterRow.objects.filter(compile_filter(expression, DESCRIPTORS)).values_list("value", flat=True)) == [2]
        expression = {"op": "or", "args": [expression, {"op": "isNull", "args": [{"property": "score"}]}]}
        assert set(FilterRow.objects.filter(compile_filter(expression, DESCRIPTORS)).values_list("value", flat=True)) == {None, 2}
    finally:
        with connection.schema_editor() as editor:
            editor.delete_model(FilterRow)


@pytest.mark.parametrize("expression", [
    {"op": "=", "args": [{"property": "unknown"}, 1]},
    {"op": "=", "args": [{"property": "score"}, "1"]},
    {"op": "like", "args": [{"property": "score"}, "1"]},
    {"op": "not", "args": []},
])
def test_invalid_filters_are_rejected(expression: dict) -> None:
    with pytest.raises(ValueError):
        compile_filter(expression, DESCRIPTORS)


def test_filter_limits_can_be_configured(settings) -> None:
    expression = {"op": "=", "args": [{"property": "score"}, 1]}
    settings.SAMPLESIFT_FILTER_MAX_DEPTH = 3
    settings.SAMPLESIFT_FILTER_MAX_NODES = 6
    compile_filter(expression, DESCRIPTORS)
    settings.SAMPLESIFT_FILTER_MAX_DEPTH = 2
    with pytest.raises(ValueError, match="deeply nested"):
        compile_filter(expression, DESCRIPTORS)
    settings.SAMPLESIFT_FILTER_MAX_DEPTH = 3
    settings.SAMPLESIFT_FILTER_MAX_NODES = 5
    with pytest.raises(ValueError, match="too complex"):
        compile_filter(expression, DESCRIPTORS)
