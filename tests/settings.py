"""Fast default settings; PostGIS integration tests use tests.postgis_settings."""

SECRET_KEY = "samplesift-tests"
INSTALLED_APPS = ["samplesift.django.apps.SamplesiftDjangoConfig"]
DATABASES = {
    "default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"},
    "samplesift": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"},
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
