#!/bin/sh
set -eu

python manage.py migrate --noinput
# Warm the tile cache only after the data below is reconciled.
python manage.py samplesift_sync_schema --no-warm-cache

# loaddata uses raw saves, so it does not invoke collection synchronization.
python manage.py shell <<'PY'
from django.core.management import call_command
from occurrences.models import Occurrence
from occurrences.samplesift import OccurrenceCollection
from samplesift.django import registry

if not Occurrence.objects.exists():
    call_command("loaddata", "obis")

# Reconcile on every startup, including after an interrupted initial import.
collection = registry.get_model(OccurrenceCollection)
source_ids = set(Occurrence.objects.values_list("pk", flat=True))
for pk in collection.objects.using(registry.target_database()).values_list("source_pk", flat=True).iterator():
    if pk not in source_ids:
        collection.objects.using(registry.target_database()).filter(source_pk=pk).delete()
for occurrence in Occurrence.objects.iterator():
    occurrence.save()
print(f"Reconciled {len(source_ids)} OBIS occurrences", flush=True)
PY

# Reconciling changed the collection version; prewarm empty-query tiles for it.
python manage.py samplesift_sync_schema

exec python manage.py runserver 0.0.0.0:8000 "$@"
