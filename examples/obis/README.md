# OBIS Django example

From the repository root, `task backend:dev` starts the local development backend.
`task dev` starts the backend and frontend together.
These tasks use `compose.dev.yml`, Django reloads, and loopback port 8002.
The development database uses a separate `samplesift-ui-dev` Compose project.
See [development tasks](../../docs/frontend-development.md) for setup and cleanup.

This example serves an OBIS occurrence collection using Django and PostGIS.
From this directory, start it with Docker Compose:

```sh
docker compose up --build
```

Initial setup may take several minutes. Once the logs say `Reconciled 9900 OBIS
occurrences`, open the explorer at `http://127.0.0.1:8001/`. The page embeds it with
the `samplesift` template tag (see
[occurrences/index.html](occurrences/templates/occurrences/index.html)).

The explorer uses the API at `http://127.0.0.1:8001/samplesift/`, which you can also
query directly:

```sh
curl http://127.0.0.1:8001/samplesift/collections/occurrences/queryables
curl -X QUERY http://127.0.0.1:8001/samplesift/collections/occurrences/results \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"op":">=","args":[{"property":"depth"},100]},"limit":10}'
```

Open the [interactive API documentation](http://127.0.0.1:8001/samplesift/docs)
or the [OpenAPI specification](http://127.0.0.1:8001/samplesift/openapi.json).
Other devices can connect at `http://172.16.14.165:8001/samplesift/docs`. If
this machine's address changes, set `DJANGO_ALLOWED_HOSTS` to a comma-separated
list containing the new address before starting Compose. The development server
is intended for a trusted network.
The results and tile examples filter for occurrences at least 50 metres deep.
The tile coordinates identify an area containing matching OBIS records.

## Tile caching

Compose starts Redis for Django's cache. Request the same vector tile twice:

```sh
curl -X QUERY http://127.0.0.1:8001/samplesift/collections/occurrences/tiles/10/543/309 \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"op":">=","args":[{"property":"depth"},50]}}' -o /dev/null
```

The first request stores the tile; the second can reuse it. Startup also runs
`samplesift_sync_schema` after reconciling the data, which prewarms the unfiltered
tiles for zoom 0–14. Inspect the keys with:

```sh
docker compose exec redis redis-cli --scan --pattern '*samplesift:tile:occurrences:*'
```

Keys have the form `samplesift:tile:occurrences:<version>:<hash>`. The version is
the collection table's last write time in epoch microseconds. Show it with:

```sh
docker compose exec db psql -U obis -d obis -c \
  'SELECT * FROM samplesift_collection_version'
```

Any write to the collection table, including raw SQL, changes the version. Tiles
stored under older versions are no longer used. Request-time tiles expire after one
hour by default, and prewarmed tiles never expire. Compose therefore limits Redis
to 256 MB with least-recently-used eviction. Redis is disposable and its data is
not persisted. Set `REDIS_URL` before starting Compose to use a different Redis
endpoint. See [Tile caching](../../docs/tile-cache.md) for details.

See the [Django collection documentation](../../docs/django-collections.md) for
more queries, including vector tiles. To stop the example, run `docker compose
down`; add `-v` to delete its database and start over.

The source and collection share a persistent PostGIS database. Startup loads the
fixture only if the source table is empty, then reconciles the collection. Run
only one app instance during initialization.

## Fixture

The fixture contains records from [this OBIS dataset](https://obis.org/dataset/ad65221f-0539-44aa-925e-4acf62ad0c6a).
It is a bounded subset in API order, not a random sample. Citation, license and
retrieval details are in [obis-source.json](occurrences/fixtures/obis-source.json).

To regenerate the fixture with Node.js 18 or later:

```sh
node scripts/fetch.mjs        # inspect up to 10,000 records
node scripts/fetch.mjs 1000   # optional limit, from 1 to 100,000
```

Reset the database volume to load a regenerated fixture.
