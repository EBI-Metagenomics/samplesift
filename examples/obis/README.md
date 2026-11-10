# OBIS Django example

This example serves an OBIS occurrence collection using Django and PostGIS.
From this directory, start it with Docker Compose:

```sh
docker compose up --build
```

Initial setup may take several minutes. Once the logs say `Reconciled 9900 OBIS
occurrences`, query the API at `http://127.0.0.1:8001/samplesift/`:

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
