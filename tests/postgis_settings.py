"""Settings for Docker-backed PostGIS integration tests."""

import os

from .settings import *

INSTALLED_APPS = [*INSTALLED_APPS, "django.contrib.postgres"]

DATABASES = {
    "default": {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": os.environ.get("POSTGRES_DB", "samplesift"),
        "USER": os.environ.get("POSTGRES_USER", "samplesift"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "samplesift"),
        "HOST": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        "PORT": os.environ.get("POSTGRES_PORT", "55432"),
    },
    "samplesift": {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": os.environ.get("POSTGRES_DB", "samplesift"),
        "USER": os.environ.get("POSTGRES_USER", "samplesift"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "samplesift"),
        "HOST": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        "PORT": os.environ.get("POSTGRES_PORT", "55432"),
    },
}
