# Viking shipping forecast area

`viking.shp` and `viking.geojson` represent the Viking shipping forecast area.
The boundary is 0–4°E, 58°30′–61°N.

The source is the Met Office's 2025 Shipping Forecast factsheet, Table 1, PDF page 12:

https://www.metoffice.gov.uk/api/assets/file/factsheet_8_shipping_forecast_2025pdf?prefix=assets

Published corners, in longitude/latitude order:

```text
(0, 61), (4, 61), (4, 58.5), (0, 58.5)
```

These local GIS files were generated from the published coordinates.
They are not official downloaded GIS products.
Both use EPSG:4326 and contain one polygon without holes.
The GeoJSON file is a single Feature with a source link.
The notebook reads these files without a runtime download.

Keep all shapefile sidecars together: `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg`.
GeoPandas is included in the notebook development dependency group.
For your own files, reproject geometry to EPSG:4326 before calling `widget.set_selection()`.

In the current 9,900-record OBIS fixture, Viking contains 1,295 occurrences.
The notebook's depth >=50 metre filter reduces this to 1,294 occurrences.
Boundary points are included.
