from typing import ClassVar

from samplesift.django import Point, SampleSiftCollection, registry

from .models import Occurrence


@registry.register
class OccurrenceCollection(SampleSiftCollection):
    fields: ClassVar[list[str]] = ["lon", "lat", "depth", "date", "name"]
    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        model = Occurrence
        api_name = "occurrences"

    class Query:
        default_ordering: ClassVar[list[str]] = ["date"]
        query_example: ClassVar[dict] = {"filter": {"op": ">=", "args": [{"property": "depth"}, 50]}}
        tile_example: ClassVar[dict[str, int]] = {"z": 10, "x": 543, "y": 309}
