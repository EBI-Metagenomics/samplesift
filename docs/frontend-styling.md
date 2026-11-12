# Frontend styling

The reusable frontend supports inherited CSS variables and named CSS parts, while retaining the existing colours and typography by default. The explorer now defaults to compact layout with no table; see [compact layout and opt-ins](frontend-compact.md). The hooks work on the full explorer and its standalone collection, filter and map components.

See the package's [styling guide](../frontend/packages/components/STYLING.md) for the public variable/part reference, limits and examples. The guide includes a [React component](../frontend/packages/components/examples/styling/react/SampleExplorer.jsx), a [Django template](../frontend/packages/components/examples/styling/django/explorer.html), and their [shared stylesheet](../frontend/packages/components/examples/styling/samplesift-theme.css).

For a React app already using Visual Framework 2, see the [EBI Visual Framework example](../frontend/packages/components/examples/styling/react-vf/README.md). It maps VF theme values to SampleSift and demonstrates named parts without adding framework dependencies.

For a local comparison, run the frontend development server with its configured API and open `/demo/styling.html`, which explicitly opts into full layout and the table to show all styling hooks. All changes are frontend-only; API filtering and host-owned URL behavior are unchanged.
