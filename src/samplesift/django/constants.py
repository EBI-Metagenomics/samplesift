"""Fixed values belonging to SampleSift's spatial and storage contracts."""

WGS84_SRID = 4326
WEB_MERCATOR_SRID = 3857
MVT_EXTENT = 4096
# MapLibre renders vector tiles at 512 pixels unless the source overrides tileSize.
VECTOR_TILE_SIZE = 512
# Web Mercator metres per pixel at zoom zero, for VECTOR_TILE_SIZE-pixel tiles.
WEB_MERCATOR_INITIAL_RESOLUTION = 78271.51696402048
# Web Mercator metres from the origin to the edge of the tile grid.
WEB_MERCATOR_ORIGIN_SHIFT = 20037508.342789244
SOURCE_PK_MAX_LENGTH = 255
