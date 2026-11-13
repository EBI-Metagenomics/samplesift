"""Tests for the thin anywidget component wrapper."""

import json
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from shutil import copyfile

import pytest

pytest.importorskip("anywidget")

from samplesift.jupyter import SampleSift


def test_widget_configuration_is_synced() -> None:
    widget = SampleSift(
        component_url="http://localhost:5174/src/index.ts",
        api_url="https://example.org/samplesift",
        collection="occurrences",
        tile_layer="occurrences",
    )
    try:
        state = widget.get_state()
        assert state["component_url"] == "http://localhost:5174/src/index.ts"
        assert state["api_url"] == "https://example.org/samplesift"
        assert state["collection"] == state["tile_layer"] == "occurrences"
        assert state["demo"] is False
        widget.demo = True
        assert widget.get_state()["demo"] is True
    finally:
        widget.close()


def test_widget_exposes_frontend_and_display_mime() -> None:
    widget = SampleSift(demo=True)
    try:
        state = widget.get_state()
        assert state["component_url"] == ""
        bundle_path = (
            Path(__file__).parents[1] / "src/samplesift/jupyter/static/dist/widget.js"
        )
        assert state["_esm"] == bundle_path.read_text()
        assert "data:" in state["_esm"]
        assert "127.0.0.1:5173" not in state["_esm"]
        bundle, _ = widget._repr_mimebundle_()
        assert (
            bundle["application/vnd.jupyter.widget-view+json"]["model_id"]
            == widget.model_id
        )
    finally:
        widget.close()


def test_result_page_replaces_rows_without_fetching_other_pages() -> None:
    widget = SampleSift()
    try:
        assert widget.rows == []
        page = {
            "state": {"predicates": [], "sort": [], "selection": None},
            "query": {"limit": 1, "offset": 0},
            "result": {
                "items": [{"source_pk": "a"}],
                "total": 500,
                "limit": 1,
                "offset": 0,
            },
        }
        widget.set_state({"page": page, "tile_status": {"loading": True}})
        assert widget.rows == [{"source_pk": "a"}]
        assert widget.page["result"]["total"] == 500
        assert widget.tile_status["loading"] is True
        widget.set_state(
            {"page": {**page, "result": {**page["result"], "items": [], "offset": 1}}}
        )
        assert widget.rows == []
    finally:
        widget.close()


def test_dataframe_requires_optional_pandas(monkeypatch) -> None:
    import sys

    monkeypatch.setitem(sys.modules, "pandas", None)
    widget = SampleSift()
    try:
        with pytest.raises(ImportError, match="Install pandas"):
            widget.to_dataframe()
    finally:
        widget.close()


def test_dataframe_contains_only_current_page() -> None:
    pytest.importorskip("pandas")
    widget = SampleSift()
    try:
        widget.page = {
            "result": {"items": [{"source_pk": "a", "depth": 12}], "total": 500}
        }
        frame = widget.to_dataframe()
        assert frame.to_dict("records") == [{"source_pk": "a", "depth": 12}]
        widget.page = {"result": {"items": [], "total": 500}}
        assert widget.to_dataframe().empty
        assert len(frame) == 1
    finally:
        widget.close()


def test_example_notebook_code(monkeypatch, tmp_path) -> None:
    pd = pytest.importorskip("pandas")
    pytest.importorskip("geopandas")
    examples = Path(__file__).parents[1] / "examples"
    notebook = json.loads((examples / "jupyter.ipynb").read_text())
    (tmp_path / "regions").mkdir()
    for source in (examples / "regions").glob("viking.*"):
        copyfile(source, tmp_path / "regions" / source.name)
    monkeypatch.chdir(tmp_path)

    def dataframe(widget, **kwargs):
        assert kwargs == {"all_rows": True, "page_size": 100}
        return pd.DataFrame.from_records([{"source_pk": "example", "depth": 55}])

    monkeypatch.setattr(SampleSift, "to_dataframe", dataframe)
    namespace = {}
    try:
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                exec(  # noqa: S102 -- Execute trusted notebook cells from this repository.
                    compile("".join(cell["source"]), "jupyter.ipynb", "exec"), namespace
                )
        assert isinstance(namespace["widget"], SampleSift)
        widget = namespace["widget"]
        assert widget.demo is False
        assert widget.api_url == "http://127.0.0.1:8002/samplesift"
        assert widget.collection == widget.tile_layer == "occurrences"
        assert widget.query_state["predicates"] == [
            {"field": "depth", "operator": ">=", "value": 50}
        ]
        assert widget.query_state["selection"] == json.loads(
            json.dumps(namespace["viking"].geometry.iloc[0].__geo_interface__)
        )
        assert (
            widget.query_state["selection"] == namespace["viking_geojson"]["geometry"]
        )
        assert namespace["viking"].crs.to_epsg() == 4326
        assert (
            (tmp_path / "selected-occurrences.csv")
            .read_text()
            .startswith("source_pk,depth")
        )
    finally:
        if "depth_slider" in namespace:
            namespace["depth_slider"].close()
        if "widget" in namespace:
            namespace["widget"].close()


def test_notebook_depth_slider_preserves_other_filters(export_widget) -> None:
    notebook = json.loads(
        (Path(__file__).parents[1] / "examples/jupyter.ipynb").read_text()
    )
    cell = next(
        cell for cell in notebook["cells"] if cell["id"] == "depth-slider-binding"
    )
    export_widget.set_selection(
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
    )
    export_widget.query_state = {
        **export_widget.query_state,
        "predicates": export_widget.query_state["predicates"]
        + [{"field": "date", "operator": ">=", "value": "2000-01-01"}],
    }
    before = deepcopy(export_widget.query_state)
    namespace = {"widget": export_widget}
    exec(  # noqa: S102 -- Exercise the trusted notebook binding example.
        compile("".join(cell["source"]), "depth-slider-binding", "exec"), namespace
    )
    slider = namespace["depth_slider"]
    try:
        slider.value = 100
        assert export_widget.query_state == {
            **before,
            "predicates": [
                {"field": "date", "operator": ">=", "value": "2000-01-01"},
                {"field": "depth", "operator": ">=", "value": 100},
            ],
        }
        assert slider.continuous_update is False
    finally:
        slider.close()


def test_viking_shapefile_and_geojson_match_and_select_an_obis_subset() -> None:
    gpd = pytest.importorskip("geopandas")
    examples = Path(__file__).parents[1] / "examples"
    source = gpd.read_file(examples / "regions/viking.shp")
    assert source.crs.to_epsg() == 4326
    assert len(source) == 1
    geometry = source.to_crs("EPSG:4326").geometry.iloc[0]
    assert geometry.is_valid
    assert geometry.geom_type == "Polygon"
    assert len(geometry.interiors) == 0
    assert geometry.bounds == (0, 58.5, 4, 61)
    geojson = json.loads((examples / "regions/viking.geojson").read_text())
    assert geojson["geometry"] == json.loads(json.dumps(geometry.__geo_interface__))
    records = json.loads((examples / "obis/occurrences/fixtures/obis.json").read_text())
    fields = [record["fields"] for record in records]
    points = gpd.points_from_xy(
        [row["lon"] for row in fields], [row["lat"] for row in fields]
    )
    selected = geometry.covers(points)
    assert sum(selected) == 1295
    assert (
        sum(
            inside and row["depth"] is not None and row["depth"] >= 50
            for inside, row in zip(selected, fields, strict=True)
        )
        == 1294
    )


@pytest.fixture
def export_widget():
    widget = SampleSift(
        api_url="http://localhost:5173/samplesift", collection="occurrences"
    )
    widget.query_state = {
        "predicates": [{"field": "depth", "operator": ">=", "value": 50}],
        "sort": ["date"],
        "selection": None,
    }
    widget.page = {
        "state": deepcopy(widget.query_state),
        "query": {
            "filter": {"op": ">=", "args": [{"property": "depth"}, 50]},
            "sort": ["date"],
            "limit": 25,
            "offset": 25,
        },
        "result": {"items": [], "total": 5, "limit": 25, "offset": 25},
    }
    try:
        yield widget
    finally:
        widget.close()


def test_all_pages_preserve_filter_sort_and_advance_by_returned_rows(
    monkeypatch, export_widget
) -> None:
    pytest.importorskip("pandas")
    requests = []
    records = [{"source_pk": str(i), "depth": 50 + i} for i in range(5)]
    expected = deepcopy(export_widget.page["query"])

    def response(request, timeout):
        query = json.loads(request.data)
        requests.append(query)
        assert request.method == "QUERY"
        assert (
            request.full_url
            == "http://localhost:5173/samplesift/collections/occurrences/results"
        )
        assert timeout == 30
        assert query["filter"] == expected["filter"]
        assert query["sort"] == expected["sort"]
        assert query["limit"] == 500
        offset = query["offset"]
        # Simulate another UI update during export: this export keeps its original query.
        export_widget.query_state = {"predicates": [], "sort": [], "selection": None}
        return BytesIO(
            json.dumps(
                {
                    "items": records[offset : offset + 2],
                    "total": 5,
                    "limit": 2,
                    "offset": offset,
                }
            ).encode()
        )

    monkeypatch.setattr("samplesift.jupyter.urlopen", response)
    frame = export_widget.to_dataframe(all_rows=True, page_size=500)
    assert frame.to_dict("records") == records
    assert [r["offset"] for r in requests] == [0, 2, 4]
    assert export_widget.page["query"]["offset"] == 25


def test_export_waits_for_matching_successful_page(export_widget) -> None:
    export_widget.query_state = {"predicates": [], "sort": [], "selection": None}
    with pytest.raises(RuntimeError, match="Wait for successful results"):
        export_widget._all_rows(None, 30)


@pytest.mark.parametrize(
    "failure", ["duplicate", "changed_total", "early_end", "wrong_offset"]
)
def test_export_rejects_inconsistent_pagination(
    monkeypatch, export_widget, failure
) -> None:
    replies = [
        {"items": [{"source_pk": "a"}], "total": 2, "limit": 1, "offset": 0},
        {"items": [{"source_pk": "b"}], "total": 2, "limit": 1, "offset": 1},
    ]
    if failure == "duplicate":
        replies[1]["items"] = [{"source_pk": "a"}]
    if failure == "changed_total":
        replies[1]["total"] = 3
    if failure == "early_end":
        replies[1]["items"] = []
    if failure == "wrong_offset":
        replies[1]["offset"] = 0
    monkeypatch.setattr(
        "samplesift.jupyter.urlopen",
        lambda request, timeout: BytesIO(json.dumps(replies.pop(0)).encode()),
    )
    with pytest.raises((RuntimeError, ValueError)):
        export_widget._all_rows(1, 30)


def test_csv_exports_all_rows_without_index(
    monkeypatch, export_widget, tmp_path
) -> None:
    pytest.importorskip("pandas")
    result = {
        "items": [{"source_pk": "a", "depth": 55}],
        "total": 1,
        "limit": 25,
        "offset": 0,
    }
    monkeypatch.setattr(
        "samplesift.jupyter.urlopen",
        lambda request, timeout: BytesIO(json.dumps(result).encode()),
    )
    path = tmp_path / "occurrences.csv"
    export_widget.to_csv(path)
    assert path.read_text() == "source_pk,depth\na,55\n"


def test_region_interfaces_preserve_filters_and_reject_unsupported_shapes(
    export_widget,
) -> None:
    polygon = {"type": "Polygon", "coordinates": (((0, 0), (1, 0), (1, 1), (0, 0)),)}

    class Geometry:
        __geo_interface__ = polygon

    original = deepcopy(export_widget.query_state)
    export_widget.set_selection(Geometry())
    assert export_widget.query_state["predicates"] == original["predicates"]
    assert export_widget.query_state["sort"] == original["sort"]
    assert export_widget.query_state["selection"] == json.loads(json.dumps(polygon))
    export_widget.set_selection({"type": "Feature", "geometry": polygon})
    with pytest.raises(ValueError, match="Polygon"):
        export_widget.set_selection({"type": "MultiPolygon", "coordinates": []})
    with pytest.raises(ValueError, match="holes"):
        export_widget.set_selection({"type": "Polygon", "coordinates": [[], []]})
    export_widget.set_selection(None)
    assert export_widget.query_state["selection"] is None


def test_missing_bundle_reports_setup_command(monkeypatch) -> None:
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    with pytest.raises(FileNotFoundError, match="task jupyter:setup"):
        SampleSift()
    widget = SampleSift(component_url="http://localhost:5173/src/index.ts")
    try:
        assert widget.component_url.endswith("/src/index.ts")
    finally:
        widget.close()
