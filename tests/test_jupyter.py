"""Tests for the thin anywidget component wrapper."""

import json
from pathlib import Path

import pytest

pytest.importorskip("anywidget")

from samplesift.jupyter import SampleSift  # noqa: E402


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
        assert widget.get_state()["_esm"]
        bundle, _ = widget._repr_mimebundle_()
        assert (
            bundle["application/vnd.jupyter.widget-view+json"]["model_id"]
            == widget.model_id
        )
    finally:
        widget.close()


def test_example_notebook_code() -> None:
    notebook = json.loads(
        (Path(__file__).parents[1] / "examples" / "jupyter.ipynb").read_text()
    )
    namespace = {}
    try:
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                exec(
                    compile("".join(cell["source"]), "jupyter.ipynb", "exec"), namespace
                )
        assert isinstance(namespace["widget"], SampleSift)
        assert namespace["widget"].demo is True
    finally:
        if "widget" in namespace:
            namespace["widget"].close()
