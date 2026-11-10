import importlib
from types import SimpleNamespace

import django
import pytest
from django.apps import apps
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command
from django.core.management.base import CommandError

from samplesift.django.registry import CollectionRegistry


def test_django_app_config_loads() -> None:
    if not settings.configured:
        settings.configure(
            INSTALLED_APPS=["samplesift.django.apps.SamplesiftDjangoConfig"],
            SECRET_KEY="samplesift-tests",
        )

    django.setup()

    config = apps.get_app_config("samplesift_django")

    assert config.name == "samplesift.django"
    assert config.label == "samplesift_django"


@pytest.mark.parametrize("alias", ["default", "samplesift"])
def test_target_database_validates_selected_backend(settings, monkeypatch, alias: str) -> None:
    registry_module = importlib.import_module("samplesift.django.registry")
    if alias == "default":
        if hasattr(settings, "SAMPLESIFT_DATABASE_ALIAS"):
            del settings.SAMPLESIFT_DATABASE_ALIAS
    else:
        settings.SAMPLESIFT_DATABASE_ALIAS = alias
    backend = SimpleNamespace(vendor="postgresql")
    monkeypatch.setattr(registry_module, "connections", {alias: backend})
    assert CollectionRegistry().target_database() == alias
    backend.vendor = "sqlite"
    with pytest.raises(ImproperlyConfigured, match=f"database '{alias}' is not PostgreSQL"):
        CollectionRegistry().target_database()
    with pytest.raises(CommandError, match=f"database '{alias}' is not PostgreSQL"):
        call_command("samplesift_sync_schema")
