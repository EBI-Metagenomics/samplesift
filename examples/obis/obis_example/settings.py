import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "local-obis-example-only")
DEBUG = True
ALLOWED_HOSTS = os.environ.get(
    "DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]"
).split(",")
INSTALLED_APPS = [
    "corsheaders",
    "django.contrib.contenttypes",
    "django.contrib.postgres",
    "django.contrib.staticfiles",
    "samplesift.django.apps.SamplesiftDjangoConfig",
    "occurrences",
]
TEMPLATES = [
    {"BACKEND": "django.template.backends.django.DjangoTemplates", "APP_DIRS": True}
]
MIDDLEWARE = ["corsheaders.middleware.CorsMiddleware"]
CORS_ALLOWED_ORIGIN_REGEXES = [r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$"]
CORS_URLS_REGEX = r"^/samplesift/"
CORS_ALLOW_METHODS = ["GET", "HEAD", "QUERY", "OPTIONS"]
ROOT_URLCONF = "obis_example.urls"
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
DATABASE = {
    "ENGINE": "django.contrib.gis.db.backends.postgis",
    "NAME": os.environ.get("POSTGRES_DB", "obis"),
    "USER": os.environ.get("POSTGRES_USER", "obis"),
    "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "obis"),
    "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
    "PORT": os.environ.get("POSTGRES_PORT", "55433"),
}
DATABASES = {"default": DATABASE.copy()}
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": os.environ.get("REDIS_URL", "redis://redis:6379/0"),
    },
}

SAMPLESIFT_CLUSTER_RADIUS_PIXELS = 16
SAMPLESIFT_CLUSTER_MAX_ZOOM = 12
