# React with the EBI Visual Framework

This example connects an existing [Visual Framework 2](https://stable.visual-framework.dev/) theme to SampleSift using CSS variables and named parts. It uses the installed `@samplesift/components` package; it adds no React or Visual Framework dependencies to SampleSift itself.

## Use in your application

1. Keep your application's normal VF stylesheet and IBM Plex Sans font setup. If you need a standalone reference, the [VF 2.5.30 stylesheet](https://assets.emblstatic.net/vf/v2.5.30/css/styles.css) is the version used to verify these token names. Load VF once in your application shell, not inside each explorer.
2. Copy [EbiSampleExplorer.jsx](EbiSampleExplorer.jsx) and [samplesift-vf.css](samplesift-vf.css) into the same directory in your React app. These are copyable examples, not package subpath exports.
3. Render the component from your client application:

```jsx
import { EbiSampleExplorer } from './EbiSampleExplorer';

export default function App() {
  return (
    <EbiSampleExplorer
      apiUrl="/samplesift"
      collection="occurrences"
      tileLayer="occurrences"
    />
  );
}
```

The default is a compact card with Filters closed and no results table. To enable the table styling demonstration, opt in explicitly:

```jsx
<EbiSampleExplorer showTable />
```

Open Results to reveal the compact table panel. For the expanded sidebar and inline table, use `<EbiSampleExplorer layout="full" showTable />`. The examples retain `showTable={false}` by default; setting full layout alone does not enable the table. Set `--samplesift-compact-height` on the wrapper to change the compact card's default 480px height (minimum 360px).

This is a plain JSX example for a browser bundle. For a server-rendered React application, load the example only on the client: the SampleSift browser entry cannot be imported during server rendering. Keep the package's worker assets when bundling.

`apiUrl` must reach a compatible SampleSift API. The default assumes the host routes `/samplesift` to that API. A separate API origin requires suitable CORS support, including the `QUERY` method. `tileLayer` is the layer name inside the collection's vector tiles.

## How styling works

The `.ebi-samplesift` wrapper maps VF colours to SampleSift's variables. They inherit into the nested explorer, filter inputs and map controls. Missing VF variables fall back to the verified VF values; the font must still be loaded by the host. Change your host's VF variables to use your service's theme, or override the SampleSift variables for this instance.

The three `::part()` rules set the Apply button size and table typography. These are example application choices. VF's ordinary `.vf-button` selectors cannot cross SampleSift's Shadow DOM, regardless of selector specificity. This mapping adopts VF colours and typography; it does not replace SampleSift's internal controls with VF components or promise identical layouts.

The theme applies only inside this wrapper. Other SampleSift instances retain their own theme or the defaults. CSS affects the UI, not the map imagery, sample markers, search queries or URL state.

See the [SampleSift styling reference](../../../STYLING.md), [VF theme tokens](https://stable.visual-framework.dev/design-tokens/theming/) and [VF typography guidance](https://stable.visual-framework.dev/components/vf-text/).
