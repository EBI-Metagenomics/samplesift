import django
from django.apps import apps
from django.conf import settings


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
