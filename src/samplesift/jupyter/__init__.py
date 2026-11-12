"""Optional anywidget wrapper for the existing SampleSift web component."""

import json
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import anywidget
from traitlets import Bool, Dict, Unicode, default

__all__ = ["SampleSift"]


class SampleSift(anywidget.AnyWidget):
    """Embed the existing frontend component in a notebook cell.

    :param component_url: Frontend module URL, served by Vite by default.
        Set this before displaying the widget.
    :param demo: Enable the component's existing synthetic demo data.
    :param api_url: Browser-accessible collection API root.
    :param collection: Collection name; empty selects the legacy component mode.
    :param tile_layer: Source layer name in the collection's vector tiles.
    :param query_state: Initial predicates, sort order, and optional GeoJSON polygon.
    """

    _esm = Path(__file__).parent / "static" / "widget.js"

    component_url = Unicode("http://127.0.0.1:5173/src/index.ts").tag(sync=True)
    demo = Bool(False).tag(sync=True)
    api_url = Unicode("").tag(sync=True)
    collection = Unicode("").tag(sync=True)
    tile_layer = Unicode("").tag(sync=True)

    query_state = Dict().tag(sync=True)
    query_error = Unicode("").tag(sync=True)
    page = Dict().tag(sync=True)
    tile_status = Dict().tag(sync=True)

    @default("query_state")
    def _default_query_state(self) -> dict[str, Any]:
        return {"predicates": [], "sort": [], "selection": None}

    @property
    def rows(self) -> list[dict[str, Any]]:
        """Return the last successful table page, without fetching other pages."""
        return self.page.get("result", {}).get("items", [])

    def set_selection(self, region: Any) -> None:
        """Set a geographic region without changing scalar filters or sorting.

        :param region: GeoJSON Polygon, Feature, or geometry with __geo_interface__.
            Coordinates must use EPSG:4326. Pass None to clear the selection.
        :raises ValueError: If the region is not one polygon without holes.
        """
        geometry = getattr(region, "__geo_interface__", region)
        if isinstance(geometry, dict) and geometry.get("type") == "Feature":
            geometry = geometry.get("geometry")
        if geometry is not None:
            if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
                raise ValueError("Select one GeoJSON Polygon in EPSG:4326.")
            if len(geometry.get("coordinates", [])) != 1:
                raise ValueError("Polygon holes are not supported by the component.")
            # Geometry libraries commonly return tuples; normalize to JSON arrays.
            geometry = json.loads(json.dumps(geometry, allow_nan=False))
        self.query_state = {**deepcopy(self.query_state), "selection": geometry}

    def _all_rows(self, page_size: int | None, timeout: float) -> list[dict[str, Any]]:
        snapshot = deepcopy(self.page)
        if (
            self.query_error
            or not snapshot
            or snapshot.get("state") != self.query_state
        ):
            raise RuntimeError(
                "Wait for successful results for the current filters and polygon."
            )
        root = urlsplit(snapshot.get("api_url", self.api_url))
        if root.scheme not in {"http", "https"} or not root.netloc:
            raise ValueError("Python export requires an absolute HTTP(S) api_url.")
        collection = snapshot.get("collection", self.collection)
        endpoint = urlunsplit(
            (
                root.scheme,
                root.netloc,
                root.path.rstrip("/")
                + f"/collections/{quote(collection, safe='')}/results",
                root.query,
                "",
            )
        )
        query = deepcopy(snapshot["query"])
        limit = page_size if page_size is not None else snapshot["result"]["limit"]
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("page_size must be a positive integer.")
        query.pop("cursor", None)
        query.update(limit=limit, offset=0)
        rows: list[dict[str, Any]] = []
        identities: set[str] = set()
        total = None
        while True:
            request = Request(
                endpoint,
                data=json.dumps(query).encode(),
                method="QUERY",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            with urlopen(request, timeout=timeout) as response:
                result = json.load(response)
            if not isinstance(result, dict):
                raise TypeError("The collection API must return a JSON object.")
            items = result.get("items")
            count = result.get("total")
            if (
                not isinstance(items, list)
                or isinstance(count, bool)
                or not isinstance(count, int)
                or count < 0
                or result.get("offset") != query["offset"]
            ):
                raise ValueError(
                    "Invalid offset pagination response from the collection API."
                )
            if total is not None and total != count:
                raise RuntimeError(
                    "The result count changed during export. Retry the export."
                )
            total = count
            for row in items:
                identity = row.get("source_pk") if isinstance(row, dict) else None
                if (
                    not isinstance(identity, str)
                    or not identity
                    or identity in identities
                ):
                    raise RuntimeError(
                        "Invalid or repeated result identity during export."
                    )
                identities.add(identity)
            rows.extend(items)
            if len(rows) > total or (not items and len(rows) < total):
                raise RuntimeError("Pagination ended inconsistently. Retry the export.")
            if len(rows) == total:
                return rows
            query["offset"] += len(items)

    def to_dataframe(
        self,
        *,
        all_rows: bool = False,
        page_size: int | None = None,
        timeout: float = 30,
    ) -> Any:
        """Copy the current page or fetch all matching rows into a DataFrame.

        :param all_rows: Fetch all pages using a snapshot of the current successful query.
        :param page_size: Export request size; defaults to the table's returned limit.
        :param timeout: Timeout in seconds for each export request.
        :return: A new DataFrame. No browser pagination or filter state is changed.
        :raises ImportError: If pandas is not installed in the kernel environment.
        :raises RuntimeError: If current results are unavailable or pagination changes.
        """
        try:
            import pandas as pd
        except ImportError as error:
            raise ImportError(
                "Install pandas in the notebook kernel for to_dataframe()."
            ) from error
        rows = self._all_rows(page_size, timeout) if all_rows else deepcopy(self.rows)
        return pd.DataFrame.from_records(rows)

    def to_csv(
        self,
        path: str | Path | None = None,
        *,
        all_rows: bool = True,
        page_size: int | None = None,
        timeout: float = 30,
        **kwargs: Any,
    ) -> str | None:
        """Export matching rows as CSV, with no pandas index column by default.

        :param path: Destination path; None returns CSV text.
        :param all_rows: Export all matches by default; False exports the visible page.
        :param page_size: Export request size; defaults to the table's returned limit.
        :param timeout: Timeout in seconds for each export request.
        :param kwargs: Additional pandas DataFrame.to_csv options.
        :return: CSV text when path is None; otherwise None.
        """
        kwargs.setdefault("index", False)
        return self.to_dataframe(
            all_rows=all_rows, page_size=page_size, timeout=timeout
        ).to_csv(path, **kwargs)
