# Jupyter wrapper

Install the optional Python integration in the notebook kernel environment:

```sh
pip install 'samplesift[jupyter]'
```

The wrapper embeds the existing `<sample-sift>` frontend component.
It contains no separate map or filter compiler.
Python exports reuse the query compiled by the frontend.
The frontend module comes from a running frontend server.
No frontend bundle is included in the Python wheel yet.
Jupyter does not download or bundle a separate OBIS dataset.
The example queries the shared backend's existing OBIS fixture.

## Source checkout

Run these setup commands from the repository root:

```sh
task frontend:setup
task jupyter:setup
```

Start the OBIS backend and Vite in one terminal:

```sh
task dev
```

Start the example notebook in another terminal:

```sh
task jupyter:lab
```

The server, kernel, and widget extensions share the project Python environment.
The notebook development group also installs pandas and GeoPandas for the examples.
Select that Python kernel in JupyterLab.
The example uses the real OBIS collection through the Vite proxy:

```python
from samplesift.jupyter import SampleSift

widget = SampleSift(
    api_url="http://127.0.0.1:5173/samplesift",
    collection="occurrences",
    tile_layer="occurrences",
    query_state={
        "predicates": [{"field": "depth", "operator": ">=", "value": 50}],
        "sort": ["date"],
        "selection": None,
    },
)
widget
```

Keep `task dev` running while using the notebook.

Use the Vite port in `api_url`, not the backend port.
Vite forwards API requests to the backend and allows local notebook `QUERY` preflights.
Low zoom levels show backend clusters; higher zoom levels show individual records.

Vite serves the real component and its worker assets.
The default module URL is `http://127.0.0.1:5173/src/index.ts`.
For another Vite port, set `component_url` when creating the widget.
The browser must reach that server and the component's map services.

## Thin component wrapper

The synced properties are `demo`, `api_url`, `collection`, and `tile_layer`.
Their Python names map directly to the component's existing JavaScript properties.
Assignments update the displayed component.
The wrapper removes its trait listeners and component when the view closes.
Set `component_url` before display; module changes do not reload an existing view.

## Receive the current page in Python

The wrapper listens to the component's existing collection state and results events.
These traits contain JSON snapshots:

| Trait | Contents |
| --- | --- |
| `query_state` | Two-way filters, sorting, and geometry selection. |
| `query_error` | Validation or search error; empty after successful state application/results. |
| `page` | The last successful response, its query, and its matching state. |
| `tile_status` | Tile loading, pending requests, errors, readiness, revision, and filter body. |

`widget.rows` contains only the last successful table page.
Pagination replaces those rows; it does not append other pages.
The matching count is `widget.page["result"].get("total")` after the first response.
The last successful page remains available while another request is pending.
Its state and query remain together in `widget.page`.
Assign a new `query_state` dictionary to update the component from Python.
The initial state waits for collection metadata before the first search.
Invalid state pauses searching and appears in `query_error`.
A later valid assignment resumes searching.
Frontend reflection does not repeat the same search.
Nested mutations inside the dictionary do not trigger trait updates.
The other traits report frontend state.

With pandas installed in the kernel environment (`task jupyter:setup` includes it):

```python
df = widget.to_dataframe()
```

The helper creates a DataFrame snapshot without another API request.
An existing DataFrame does not update after a later browser event.
Observe `page` for subsequent responses:

```python
def on_page(change):
    global df
    df = widget.to_dataframe()

widget.observe(on_page, names="page")
```

Tile events contain status only, not binary tile payloads or occurrence rows.
Read `widget.tile_status` for the latest loading status.
The component emits `collectiontileschange` across Shadow DOM boundaries.

## Link a notebook depth slider

The notebook includes a standard `ipywidgets.IntSlider` with one traitlets observer.
Releasing the slider sets the minimum depth through `query_state`.
It preserves the polygon, sorting, and filters on other fields.
No additional dependency is needed.

## Select Viking from a shapefile or GeoJSON

The notebook includes the Viking shipping forecast area: 0–4°E, 58°30′–61°N.
Its corners come from [Met Office Factsheet 8, Table 1 (PDF page 12)](https://www.metoffice.gov.uk/api/assets/file/factsheet_8_shipping_forecast_2025pdf?prefix=assets).
The included files are local GIS conversions of those published coordinates.
They are not official downloaded GIS products.
Viking selects 1,295 occurrences from the current fixture; depth >=50 metres leaves 1,294.

`task jupyter:setup` installs GeoPandas alongside pandas.
For the shapefile:

```python
import geopandas as gpd
from pathlib import Path

viking = gpd.read_file(Path("regions/viking.shp")).to_crs("EPSG:4326")
widget.set_selection(viking.geometry.iloc[0])
```

For the equivalent GeoJSON Feature:

```python
import json

viking_geojson = json.loads(Path("regions/viking.geojson").read_text())
widget.set_selection(viking_geojson)
```

Both calls update the map polygon and search while preserving scalar filters and sorting.
The example paths are relative to the notebook directory.
Keep the `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg` files together.
See [region fixture details](../examples/regions/README.md) for the source coordinates.
No region download is required during notebook execution.

The helper accepts a geometry with `__geo_interface__`, a GeoJSON Polygon, or a Feature.
Pass `None` to clear the region.
The current component supports one polygon without holes.
MultiPolygons, holes, antimeridian crossings, and overly complex boundaries require preparation before selection.
The component validates the coordinates and reports errors through `query_error`.
Always reproject file geometries to EPSG:4326 before passing them to the widget.
Coordinates use longitude before latitude.

## Export all matching occurrences

Wait for the table to finish updating after a filter or polygon change.
Then fetch all matching pages from Python:

```python
df = widget.to_dataframe(all_rows=True, page_size=500)
df.to_csv("selected-occurrences.csv", index=False)
```

This uses a fixed copy of the successful table query, including its polygon and sorting.
It starts at offset zero, independently of the visible table page.
The default export page size reuses the table's returned limit.
Use an explicit `page_size` within the backend's advertised limits.
Python advances by the returned row count, including when the backend caps pages.
The browser's table page and map remain unchanged.
An export waits for a matching successful page; otherwise the method raises an error.
Requests use HTTP `QUERY` directly from the kernel, with a per-request timeout of 30 seconds.
The API URL must be absolute and reachable from the kernel.
The helper does not inherit browser authentication cookies.

A direct CSV convenience method also fetches all matches by default:

```python
widget.to_csv("selected-occurrences.csv", page_size=500)
```

Use `all_rows=False` on either method for the current page only.
`to_csv()` omits the pandas index unless explicitly requested.
With no path, `to_csv()` returns CSV text.
Exports load the matching rows into memory.
They are not transactional database snapshots.
Changed totals, repeated record identities, and incomplete pagination raise errors instead of returning a partial export.

## Golem widget loading

Vite pre-bundles Golem's lazy widget loaders before notebook imports.
After changing frontend dependencies, restart Vite and reload the notebook browser tab.
An old module graph can otherwise produce `504 Outdated Optimize Dep` and a Golem grid error.

For collection mode, supply the existing component's API configuration:

```python
widget = SampleSift(
    api_url="https://your-api.example/samplesift",
    collection="occurrences",
    tile_layer="occurrences",
)
widget
```

The API URL is resolved by the browser, not Python.
Jupyter and Vite have different origins.
Remote APIs must allow the notebook origin and HTTP `QUERY` preflights.
The development Vite server allows localhost notebook origins.
Its worker URLs resolve against Vite, independently of the notebook URL.

## Jupyter extension-manager errors

A traceback from `/lab/api/extensions` concerns JupyterLab's extension catalog, not map tiles.
The installed JupyterLab PyPI manager can raise `UnboundLocalError` after a catalog request fails.
Use its read-only manager to avoid catalog searches during development:

```sh
task jupyter:lab -- --LabApp.extension_manager=readonly
```

Installed widget extensions still load with that manager.

## Checks

```sh
task jupyter:test
task build
```

The Python tests check synced traits, widget MIME data, and notebook code.
The wrapper requires a frontend with widget support, such as JupyterLab.
For separate server and kernel environments, install anywidget in both environments.
Restart JupyterLab after installing its widget extensions.
