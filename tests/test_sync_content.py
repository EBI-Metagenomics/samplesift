"""Content-sync command selection works without database access."""

from io import StringIO
from unittest.mock import Mock

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> Mock:
    registry = Mock(collections=())
    monkeypatch.setattr(
        "samplesift.django.management.commands.samplesift_sync_content.registry",
        registry,
    )
    return registry


def test_no_collections_needs_no_database(registry: Mock) -> None:
    output = StringIO()
    call_command("samplesift_sync_content", stdout=output)
    assert "No SampleSift collections registered" in output.getvalue()
    registry.target_database.assert_not_called()


def test_unknown_collection_is_an_error(registry: Mock) -> None:
    with pytest.raises(CommandError, match="Unknown SampleSift collection 'missing'"):
        call_command("samplesift_sync_content", "missing")
    registry.target_database.assert_not_called()


def test_ambiguous_collection_is_an_error(registry: Mock) -> None:
    registry.collections = [
        Mock(api_name=lambda: "same"),
        Mock(api_name=lambda: "same"),
    ]
    with pytest.raises(CommandError, match="Ambiguous collection"):
        call_command("samplesift_sync_content", "same")
    registry.target_database.assert_not_called()
