"""Validated SampleSift configuration."""

from dataclasses import dataclass

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


@dataclass(frozen=True)
class SampleSiftSettings:
    filter_max_depth: int
    filter_max_nodes: int
    default_page_size: int
    max_page_size: int
    cluster_radius_pixels: int
    cluster_max_zoom: int
    cache_timeout: int


def get_settings() -> SampleSiftSettings:
    defaults = {
        "filter_max_depth": (20, 0),
        "filter_max_nodes": (500, 1),
        "default_page_size": (100, 1),
        "max_page_size": (500, 1),
        "cluster_radius_pixels": (40, 1),
        "cluster_max_zoom": (14, 0),
        "cache_timeout": (3600, 1),
    }
    values = {}
    for key, (default, minimum) in defaults.items():
        name = f"SAMPLESIFT_{key.upper()}"
        value = getattr(settings, name, default)
        if type(value) is not int or value < minimum:
            raise ImproperlyConfigured(f"{name} must be an integer greater than or equal to {minimum}.")
        values[key] = value
    if values["default_page_size"] > values["max_page_size"]:
        raise ImproperlyConfigured("SAMPLESIFT_DEFAULT_PAGE_SIZE must not exceed SAMPLESIFT_MAX_PAGE_SIZE.")
    alias = getattr(settings, "SAMPLESIFT_CACHE_ALIAS", None)
    if alias is not None and (not isinstance(alias, str) or alias not in settings.CACHES):
        raise ImproperlyConfigured("SAMPLESIFT_CACHE_ALIAS must name a configured cache.")
    return SampleSiftSettings(**values)
