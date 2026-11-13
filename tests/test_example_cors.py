"""Check local notebook access to the OBIS example without Vite."""

from importlib import import_module
from pathlib import Path

import pytest
from django.http import HttpResponse
from django.test import RequestFactory
from django.utils.module_loading import import_string


@pytest.fixture
def middleware(monkeypatch, settings):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[1] / "examples/obis"))
    example = import_module("obis_example.settings")
    for name in (
        "CORS_ALLOWED_ORIGIN_REGEXES",
        "CORS_URLS_REGEX",
        "CORS_ALLOW_METHODS",
    ):
        setattr(settings, name, getattr(example, name))
    return import_string(example.MIDDLEWARE[0])


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://localhost:8888", True),
        ("http://127.0.0.1:8888", True),
        ("https://[::1]:8888", True),
        ("https://example.org", False),
        ("http://localhost.example.org:8888", False),
        ("null", False),
    ],
)
def test_notebook_api_preflight(middleware, origin, allowed) -> None:
    calls = []

    def downstream(request):
        calls.append(request)
        return HttpResponse(status=405)

    request = RequestFactory().options(
        "/samplesift/collections/occurrences/results",
        HTTP_ORIGIN=origin,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="QUERY",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type",
    )
    response = middleware(downstream)(request)
    assert response.status_code == 200
    assert not calls
    assert response.get("Access-Control-Allow-Origin") == (origin if allowed else None)
    assert response["Vary"].lower() == "origin"
    if allowed:
        assert "QUERY" in response["Access-Control-Allow-Methods"]
        assert "content-type" in response["Access-Control-Allow-Headers"].lower()


def test_notebook_api_response(middleware) -> None:
    response = HttpResponse("results")
    app = middleware(lambda request: response)
    factory = RequestFactory()
    assert (
        app(
            factory.generic(
                "QUERY",
                "/samplesift/collections/occurrences/results",
                HTTP_ORIGIN="http://localhost:8888",
            )
        )
        is response
    )
    assert response["Access-Control-Allow-Origin"] == "http://localhost:8888"
    other = HttpResponse("other")
    app = middleware(lambda request: other)
    assert app(factory.options("/other", HTTP_ORIGIN="http://localhost:8888")) is other
    assert "Access-Control-Allow-Origin" not in other
