"""Optional anywidget wrapper for the existing SampleSift web component."""

from pathlib import Path

import anywidget
from traitlets import Bool, Unicode

__all__ = ["SampleSift"]


class SampleSift(anywidget.AnyWidget):
    """Embed the existing frontend component in a notebook cell.

    :param component_url: Frontend module URL, served by Vite by default.
        Set this before displaying the widget.
    :param demo: Enable the component's existing synthetic demo data.
    :param api_url: Browser-accessible collection API root.
    :param collection: Collection name; empty selects the legacy component mode.
    :param tile_layer: Source layer name in the collection's vector tiles.
    """

    _esm = Path(__file__).parent / "static" / "widget.js"

    component_url = Unicode("http://127.0.0.1:5173/src/index.ts").tag(sync=True)
    demo = Bool(False).tag(sync=True)
    api_url = Unicode("").tag(sync=True)
    collection = Unicode("").tag(sync=True)
    tile_layer = Unicode("").tag(sync=True)
