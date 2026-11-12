import pytest
from django.core.exceptions import ImproperlyConfigured

from samplesift.django.config import get_settings


@pytest.mark.parametrize("name,value", [
    ("SAMPLESIFT_FILTER_MAX_DEPTH", -1),
    ("SAMPLESIFT_FILTER_MAX_NODES", 0),
    ("SAMPLESIFT_DEFAULT_PAGE_SIZE", True),
    ("SAMPLESIFT_MAX_PAGE_SIZE", 0),
    ("SAMPLESIFT_CLUSTER_RADIUS_PIXELS", 1.5),
    ("SAMPLESIFT_CLUSTER_MAX_ZOOM", -1),
    ("SAMPLESIFT_CACHE_TIMEOUT", 0),
    ("SAMPLESIFT_CACHE_ALIAS", "missing"),
])
def test_invalid_configuration_is_rejected(settings, name, value):
    setattr(settings, name, value)
    with pytest.raises(ImproperlyConfigured, match=name):
        get_settings()


def test_default_page_cannot_exceed_maximum(settings):
    settings.SAMPLESIFT_DEFAULT_PAGE_SIZE = 11
    settings.SAMPLESIFT_MAX_PAGE_SIZE = 10
    with pytest.raises(ImproperlyConfigured, match="SAMPLESIFT_DEFAULT_PAGE_SIZE"):
        get_settings()
