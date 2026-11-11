# Jupyter wrapper

Install the optional Python integration in the notebook kernel environment:

```sh
pip install 'samplesift[jupyter]'
```

The wrapper embeds the existing `<sample-sift>` frontend component.
It contains no separate map, data adapter, or query implementation.
The frontend module comes from a running frontend server.
No frontend bundle is included in the Python wheel yet.

## Source checkout

Run these setup commands from the repository root:

```sh
task frontend:setup
task jupyter:setup
```

Start Vite in one terminal:

```sh
task frontend:dev
```

Start the example notebook in another terminal:

```sh
task jupyter:lab
```

The server, kernel, and widget extensions share the project Python environment.
Select that Python kernel in JupyterLab.
The example uses the component's existing synthetic demo mode:

```python
from samplesift.jupyter import SampleSift

widget = SampleSift(demo=True)
widget
```

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
The API must allow the notebook origin and HTTP `QUERY` preflights.
The existing Vite proxy does not automatically solve this notebook CORS requirement.
Local OBIS collection integration needs further frontend or hosting work.
This change does not modify the frontend's transport, filters, or events.

## Checks

```sh
task jupyter:test
task build
```

The Python tests check synced traits, widget MIME data, and notebook code.
The wrapper requires a frontend with widget support, such as JupyterLab.
For separate server and kernel environments, install anywidget in both environments.
Restart JupyterLab after installing its widget extensions.
