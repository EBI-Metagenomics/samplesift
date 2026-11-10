from django.apps import AppConfig
from django.utils.module_loading import autodiscover_modules


class SamplesiftDjangoConfig(AppConfig):
    """Django application configuration for Samplesift."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "samplesift.django"
    label = "samplesift_django"

    def ready(self) -> None:
        from .config import get_settings

        get_settings()
        autodiscover_modules("samplesift")
