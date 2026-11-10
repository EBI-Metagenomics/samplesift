"""Shared PostGIS settings for the test suite."""

import os

SECRET_KEY = "samplesift-tests"
INSTALLED_APPS = ["samplesift.django.apps.SamplesiftDjangoConfig", "django.contrib.postgres"]
GDAL_LIBRARY_PATH = os.environ.get("GDAL_LIBRARY_PATH")
GEOS_LIBRARY_PATH = os.environ.get("GEOS_LIBRARY_PATH")
_database = {
    "ENGINE": "django.contrib.gis.db.backends.postgis",
    "NAME": os.environ.get("POSTGRES_DB", "samplesift"),
    "USER": os.environ.get("POSTGRES_USER", "samplesift"),
    "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "samplesift"),
    "HOST": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
    "PORT": os.environ.get("POSTGRES_PORT", "55432"),
}
DATABASES = {
    "default": {**_database, "TEST": {"NAME": f"test_{_database['NAME']}"}},
    "samplesift": {**_database, "TEST": {"NAME": f"test_{_database['NAME']}_samplesift"}},
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
