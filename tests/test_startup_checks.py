"""Startup checks explain missing collection storage without blocking setup."""

import sys
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from django.apps import apps
from django.core.checks import Tags
from django.core.management import call_command
from django.core.management.base import SystemCheckError
from django.db import OperationalError

from samplesift.django import checks


@pytest.fixture
def storage(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    registry = SimpleNamespace(
        collections=[
            SimpleNamespace(table_name=lambda: "samplesift_sample_collection")
        ],
        target_database=Mock(return_value="samplesift"),
    )
    introspection = Mock()
    introspection.table_names.return_value = []
    monkeypatch.setattr(checks, "registry", registry)
    monkeypatch.setattr(
        checks,
        "connections",
        {"samplesift": SimpleNamespace(introspection=introspection)},
    )
    return SimpleNamespace(registry=registry, introspection=introspection)


def test_missing_tables_identify_database_and_setup_command(
    storage: SimpleNamespace,
) -> None:
    errors = checks.check_collection_tables()
    assert len(errors) == 1
    assert errors[0].id == "samplesift.E001"
    assert errors[0].obj == "database 'samplesift'"
    assert "samplesift_sample_collection" in errors[0].msg
    assert "python manage.py samplesift_sync_schema" in errors[0].hint


def test_existing_tables_pass(storage: SimpleNamespace) -> None:
    storage.introspection.table_names.return_value = ["samplesift_sample_collection"]
    assert checks.check_collection_tables() == []


def test_no_collections_needs_no_database(storage: SimpleNamespace) -> None:
    storage.registry.collections = []
    assert checks.check_collection_tables() == []
    storage.registry.target_database.assert_not_called()
    storage.introspection.table_names.assert_not_called()


def test_database_errors_have_configuration_hint(storage: SimpleNamespace) -> None:
    storage.introspection.table_names.side_effect = OperationalError(
        "connection refused"
    )
    (error,) = checks.check_collection_tables()
    assert error.id == "samplesift.E002"
    assert "connection refused" in error.msg
    assert "SAMPLESIFT_DATABASE_ALIAS" in error.hint


@pytest.mark.parametrize(
    "command",
    ["migrate", "makemigrations", "samplesift_sync_schema", "collectstatic", "test"],
)
def test_setup_commands_skip_startup_check(
    storage: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, command: str
) -> None:
    monkeypatch.setattr(sys, "argv", ["manage.py", command])
    assert checks.check_runserver_collection_tables() == []
    storage.introspection.table_names.assert_not_called()


def test_runserver_fails_before_serving(
    storage: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, settings: object
) -> None:
    monkeypatch.setattr(sys, "argv", ["manage.py", "runserver", "--noreload"])
    settings.DEBUG = True
    with pytest.raises(SystemCheckError, match="samplesift.E001") as error:
        call_command(
            "runserver", use_reloader=False, skip_checks=False, stdout=StringIO()
        )
    assert "samplesift_sync_schema" in str(error.value)


def test_deployment_check_reports_missing_tables(
    storage: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "argv", ["manage.py", "check", "--deploy"])
    with pytest.raises(SystemCheckError, match="samplesift.E001"):
        call_command("check", deploy=True, tags=[Tags.database], stdout=StringIO())


def test_app_ready_does_not_query_storage(storage: SimpleNamespace) -> None:
    apps.get_app_config("samplesift_django").ready()
    storage.introspection.table_names.assert_not_called()
