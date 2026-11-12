import pytest
from django.template import Context, Template, TemplateSyntaxError

from samplesift.django import Point, SampleSiftCollection, registry
from samplesift.django.api import api  # noqa: F401  # Register API routes before the stand-in below.


class TemplateTagCollection(SampleSiftCollection):
    """Stand-in for a spatial collection; the tag only reads its API name."""

    geometry = Point(longitude="lon", latitude="lat")

    class Meta:
        api_name = "tag-samples"


@pytest.fixture(autouse=True)
def tag_collection(settings, monkeypatch):
    settings.ROOT_URLCONF = "tests.urls"
    monkeypatch.setitem(registry._api_names, "tag-samples", TemplateTagCollection)


def render(markup: str, **context: object) -> str:
    html = Template("{% load samplesift %}" + markup).render(Context(context))
    return " ".join(html.split())


def test_renders_collection_explorer() -> None:
    html = render('{% samplesift "tag-samples" %}')

    assert '<script type="module" src="/static/samplesift/components/sample-sift.js"></script>' in html
    assert (
        '<sample-sift api-url="/samplesift/" collection="tag-samples" '
        'tile-layer="tag-samples" page-size="100"></sample-sift>'
    ) in html


def test_renders_optional_attributes() -> None:
    html = render(
        '{% samplesift "tag-samples" page_size=25 filter_mode="manual" filter_debounce_ms=0 '
        'api_url="https://api.example/samplesift" id="left" class="explorer wide" %}'
    )

    assert 'api-url="https://api.example/samplesift"' in html
    assert 'page-size="25"' in html
    assert 'filter-mode="manual"' in html
    assert 'filter-debounce-ms="0"' in html
    assert 'id="left"' in html
    assert 'class="explorer wide"' in html


def test_caps_page_size(settings) -> None:
    settings.SAMPLESIFT_MAX_PAGE_SIZE = 200

    assert 'page-size="200"' in render('{% samplesift "tag-samples" page_size=1000 %}')


def test_includes_script_once_per_template() -> None:
    html = render('{% samplesift "tag-samples" id="left" %}{% samplesift "tag-samples" id="right" %}')

    assert html.count("<script") == 1
    assert html.count("<sample-sift ") == 2


def test_escapes_attributes() -> None:
    html = render('{% samplesift "tag-samples" class=css %}', css='x" onload="alert(1)')

    assert 'class="x&quot; onload=&quot;alert(1)"' in html


def test_rejects_unknown_collection() -> None:
    with pytest.raises(KeyError, match="Unknown SampleSift collection 'missing'"):
        render('{% samplesift "missing" %}')


@pytest.mark.parametrize(
    "markup",
    ['{% samplesift "tag-samples" filter_mode="live" %}', '{% samplesift "tag-samples" style="x" %}'],
)
def test_rejects_invalid_arguments(markup: str) -> None:
    with pytest.raises(TemplateSyntaxError):
        render(markup)
