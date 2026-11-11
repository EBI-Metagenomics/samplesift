# Jupyter wrapper

Install the optional Python integration in the notebook kernel environment:

```sh
pip install 'samplesift[jupyter]'
```

The wrapper embeds the existing `<sample-sift>` frontend component.
It contains no separate map, data adapter, or query implementation.
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
Select that Python kernel in JupyterLab.
The example uses the real OBIS collection through the Vite proxy:

```python
from samplesift.jupyter import SampleSift

widget = SampleSift(
    api_url="http://127.0.0.1:5173/samplesift",
    collection="occurrences",
    tile_layer="occurrences",
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
