# Styling SampleSift

SampleSift keeps its existing colours and typography when no theme is supplied. The explorer defaults to compact layout with its table disabled; use `layout="full" show-table` to opt into the expanded view and table. All public elements support ordinary CSS custom properties, and selected elements inside their Shadow DOM are exposed as named CSS parts. These hooks work in React, Django templates, and plain HTML without a framework-specific styling adapter.

Use **variables** to change the overall theme and **parts** for a particular control or layout area. Neither changes filter state, API requests, or the host application's URL.

## Start with a theme

Apply variables to the custom element itself or to a surrounding element. They inherit through the explorer, filter form, and map. Scope a theme to a wrapper to style one instance independently:

```css
.my-theme {
  --samplesift-accent: #175da8;
  --samplesift-accent-hover: #104b8a;
  --samplesift-on-accent: #fff;
  --samplesift-font: system-ui, sans-serif;
  --samplesift-control-radius: 6px;
}

.my-theme sample-sift::part(apply-button) {
  min-height: 44px;
}
```

```html
<div class="my-theme">
  <sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences"></sample-sift>
</div>
```

Every variable has a fallback at its point of use. Defaults intentionally differ between controls to preserve the original design; setting a variable gives those controls a shared value. Removing the variable restores their defaults. There is no theme object to construct or apply method to call.

## CSS variables

| Variables | What they style |
| --- | --- |
| `--samplesift-font` | Font family, including generated filter inputs and map controls. |
| `--samplesift-font-size`, `--samplesift-line-height` | Base explorer typography. Headings and individual controls retain their own sizes; use parts to change them. |
| `--samplesift-text`, `--samplesift-muted` | Main text and secondary descriptions. |
| `--samplesift-accent`, `--samplesift-accent-hover`, `--samplesift-on-accent` | Primary actions, their hover colour, and text on primary backgrounds. |
| `--samplesift-surface`, `--samplesift-surface-muted` | Main panels/cards and secondary backgrounds. |
| `--samplesift-border-color` | Panel, card, table, and other separating borders. |
| `--samplesift-control-background`, `--samplesift-control-text`, `--samplesift-control-border-color` | Input and secondary control colours, including Golem-generated inputs. Primary actions use the accent variables. |
| `--samplesift-focus-color` | Visible keyboard focus indicators. |
| `--samplesift-radius`, `--samplesift-control-radius` | Panel/card and control corner rounding. Pills and circular markers retain their shape. |
| `--samplesift-error-color`, `--samplesift-error-background` | Error text and backgrounds, including filter validation. |
| `--samplesift-warning-color`, `--samplesift-warning-background` | Warning text and notice backgrounds where present. |
| `--samplesift-sidebar-width` | Explorer filter sidebar width; the responsive single-column layout still takes over on small screens. |
| `--samplesift-panel-padding` | Explorer filter panel and map layer panel padding. Accepts ordinary CSS padding values. |
| `--samplesift-filter-card-padding` | Padding within collection filter cards. |
| `--samplesift-compact-height` | Height of the complete compact explorer: 480px by default, with a 360px minimum. Panels scroll inside this space. |
| `--samplesift-map-height` | Map height inside a full-layout explorer. For a standalone `sample-sift-map`, set the element's CSS `height`. |
| `--samplesift-shadow` | Collection filter card and legacy explorer shadows. |
| `--samplesift-color-scheme` | Explorer native-control colour scheme (`light` by default). Set matching surface, text and control colours yourself for a dark theme. |
| `--samplesift-accent-soft`, `--samplesift-error-border-color` | Legacy sample-mode status dot and validation border colours. |

Variables accept the normal CSS value for the property they control: colours, lengths, font-family lists, or shadows. Font variables do not download a font; load it in your host application. Set readable text/background pairs and retain visible focus and disabled states when overriding controls.

The generated filter inputs use a bridge from these variables to Golem's colour, font, border and radius settings. Consumers do not need to depend on Golem's internal class names or token names. If two variants need different themes, give their wrappers different variable values.

## Named parts

Use `sample-sift::part(name)` to style a documented part. The collection and map parts are forwarded through the nested components, so consumers can target them from the outer explorer. The same part names work on the direct component that owns them, for example `sample-sift-map::part(map-toolbar)` or `sample-sift-collection-filter-form::part(apply-button)`.

| Area | Part names |
| --- | --- |
| Compact controls | `compact-toolbar`, `panel-toggle`, `panel-heading`, `panel-close`, `compact-summary` |
| Collection layout | `explorer`, `filter-panel`, `region-summary`, `results`, `results-heading`, `results-count` |
| Collection filters | `filter-form`, `filter-heading`, `filter-title`, `filter-card`, `filter-label`, `filter-condition`, `filter-remove`, `filter-fields`, `filter-add`, `filter-picker`, `filter-search`, `filter-option`, `filter-actions` |
| Filter actions and feedback | `apply-button`, `discard-button`, `clear-button`, `filter-status`, `filter-error` |
| Applied filters and records | `applied-filters`, `filter-chip`, `feature-details`, `record-link`, `sort-control` |
| Results table | `table-container`, `results-table`, `table-head`, `table-header-cell`, `table-body`, `table-row`, `table-cell` |
| Paging and result feedback | `pagination`, `page-button`, `status`, `error`, `empty-state` |
| Map and drawing controls | `map`, `map-surface`, `map-toolbar`, `map-button` |
| Map layers and feedback | `map-layer-toggle`, `map-layers-panel`, `map-layer-option`, `map-opacity`, `map-legend`, `map-status`, `map-retry` |

Parts appear only when their corresponding UI is present. A name can match several elements, such as every table cell or map button. `map` remains the actual MapLibre container; `map-surface` wraps the map and its own controls.

`filter-fields` exposes the generated form container, not each native input. Use the control variables for those inputs. The legacy fixed-filter mode separately exposes `filter-input` on its own native inputs and reuses applicable layout/table/map parts; collection-only parts such as `filter-picker` are absent there.

Parts are deliberate styling hooks, not access to arbitrary internal selectors. For example, `::part(filter-fields) input` will not reach the generated input. State pseudo-classes on the part itself are supported, such as `::part(apply-button):disabled`. Internal class names and undocumented third-party markup are not part of the styling contract.

## React example

Copy [SampleExplorer.jsx](examples/styling/react/SampleExplorer.jsx) and [samplesift-theme.css](examples/styling/samplesift-theme.css), preserving their relative import or adjusting it. The example imports the installed `@samplesift/components` package and places the element inside a themed wrapper:

```jsx
import '@samplesift/components';
import './samplesift-theme.css';

export function SampleExplorer() {
  return (
    <div className="sample-theme">
      <sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences" />
    </div>
  );
}
```

The copyable React examples accept `layout` and `showTable` props, defaulting to `'compact'` and `false`. To see the table styling, render `<SampleExplorer showTable />` and open Results; use `<SampleExplorer layout="full" showTable />` for the expanded view. Their JSX omits `show-table` when false rather than rendering the string `"false"`.

The example is plain JSX and assumes a normal browser bundle. In a server-rendered React application, load the package only on the client; importing the custom-element bundle during server rendering is not supported. The component needs no React-specific theme provider. A bundler must retain the package's referenced worker assets.

### React with the EBI Visual Framework

The [VF React example](examples/styling/react-vf/README.md) includes a copyable [component](examples/styling/react-vf/EbiSampleExplorer.jsx) and [theme stylesheet](examples/styling/react-vf/samplesift-vf.css). It maps the host's Visual Framework 2 colour variables and IBM Plex Sans font to SampleSift, then uses named parts for the Apply button and table. Your React app supplies its usual VF stylesheet and fonts; SampleSift adds no VF dependency. Pass `showTable` to the example to enable the Results panel and see the table styling, or `layout="full" showTable` to show it inline.

## Django template example

Copy the **complete** installed package `dist/` tree into your application's `static/samplesift/` directory. Put [samplesift-theme.css](examples/styling/samplesift-theme.css) alongside `sample-sift.js` there, and use [explorer.html](examples/styling/django/explorer.html) as a template. It links the stylesheet and loads the component using Django's static URL helper:

```django
{% load static %}
<link rel="stylesheet" href="{% static 'samplesift/samplesift-theme.css' %}">
<script type="module" src="{% static 'samplesift/sample-sift.js' %}"></script>
<div class="sample-theme">
  <sample-sift api-url="/samplesift" collection="occurrences" tile-layer="occurrences"></sample-sift>
</div>
```

The copyable Django template accepts optional `samplesift_layout` (`'compact'` or `'full'`) and boolean `samplesift_show_table` context values. Its defaults remain compact with no table. The `show-table` attribute is emitted only when the context value is true. For a fixed expanded embed, add `layout="full" show-table` directly to the element.

Keep all JavaScript chunks and worker files with their original relative paths. If your static pipeline renames assets, it must also preserve or rewrite their module and worker references; serving the unchanged `dist/` tree is the simplest approach. The Django template supplies HTML; the explorer runs in the browser.

Both examples assume `/samplesift` is routed to a compatible API on the same origin. An absolute API URL also works if the backend allows your page's origin and the `QUERY` method through CORS. The package does not set up that route or change your application's URL state.

## Local preview and boundaries

Run the frontend development server and open [`/demo/styling.html`](demo/styling.html) to compare the default colours and the shared blue theme. This styling demo explicitly opts into full layout and the table so every styled area is visible. Both examples use the configured local collection API.

CSS changes the surrounding UI. Raster imagery, sample markers, clusters and drawn geometry are rendered by MapLibre and are not styled with these CSS variables. Use the existing `mapLayers`/`mapStyle` configuration for map sources and styles. No new slots or replacement-renderer API is introduced by these styling hooks.
