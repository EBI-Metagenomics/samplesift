# Compact frontend layout

SampleSift now defaults to `layout="compact"` and `showTable = false`. These presentation options are available on both `<sample-sift>` and `<sample-sift-collection>`. The map-only element remains available for hosts that supply their own controls.

## Host opt-ins

```html
<!-- Default: map-first, Filters closed, no table or Results toggle. -->
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences"></sample-sift>

<!-- Compact with a Results panel that the user can open. -->
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" show-table></sample-sift>

<!-- Expanded filter sidebar and inline table. -->
<sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" layout="full" show-table></sample-sift>
```

Full layout alone does not enable the table. `show-table` is an HTML boolean attribute: writing `show-table="false"` enables it. Omit the attribute or set the JavaScript property `showTable` to `false` to disable it. The React examples handle this by emitting `show-table={showTable ? '' : undefined}`.

## Behaviour and sizing

The compact card defaults to 480px tall, with a minimum of 360px. Hosts can set `--samplesift-compact-height`; the map fills the space between the compact controls and status summary. `--samplesift-map-height` applies to the map in full layout. Panels scroll inside the card and respond to the embedded component's width rather than relying only on the browser viewport.

Filters and the optional Results panel start closed, and only one of those panels is open at a time. The map, selected region, selected record, filter drafts and current results page remain intact as panels open and close. Collection filters retain explicit Apply by default. Closing a panel with its button or Escape restores focus to its toggle. Map layers have their own controls, coordinated with the explorer panels.

Counts and search feedback remain available when panels are closed. Open panels leave a strip of the map visible for attribution. `showTable` controls presentation only: collection searches still request result pages because the API supplies counts in those responses and has no separate count-only endpoint. Map tile requests and compiled filters are unchanged. No backend changes or URL/history synchronization are introduced by these layout options.

## Styling and examples

Run the frontend development server and open `/demo/compact.html` for two independent compact embeds.

The existing CSS variables continue to theme all layouts. New named parts are `compact-toolbar`, `panel-toggle`, `panel-heading`, `panel-close` and `compact-summary`; they are forwarded through the outer explorer. See the [styling guide](../frontend/packages/components/STYLING.md) for the complete reference.

The [React example](../frontend/packages/components/examples/styling/react/SampleExplorer.jsx), [EBI Visual Framework React example](../frontend/packages/components/examples/styling/react-vf/README.md) and [Django template](../frontend/packages/components/examples/styling/django/explorer.html) default to compact mode with no table. Each documents the explicit opt-ins for showing table styling.

For existing consumers that need the previous expanded presentation, add both `layout="full"` and `show-table`. Merely upgrading the package now yields the compact, table-free layout.
