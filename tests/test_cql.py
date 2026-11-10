import pytest
from django.db import connection, models

from samplesift.django.filters import compile_filter
from samplesift.query import Queryable


class FilterRow(models.Model):
    value = models.IntegerField(null=True)

    class Meta:
        app_label = "samplesift_api_tests"


DESCRIPTORS = {"score": (Queryable("score", {"type": "integer"}, ("=", "<>", ">", "in", "isNull")), "value")}


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
