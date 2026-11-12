"""Template tags for embedding the SampleSift collection explorer."""

from typing import Any

from django import template
from django.urls import reverse

from ..api import api
from ..config import get_settings
from ..registry import registry

register = template.Library()

_SCRIPT_RENDERED = "samplesift_script_rendered"


def _api_root() -> str:
    return reverse(f"{api.urls_namespace}:openapi-json").removesuffix("openapi.json")


@register.inclusion_tag("samplesift/sample_sift.html", takes_context=True)
def samplesift(
    context: template.Context,
    collection: str,
    *,
    page_size: int | None = None,
    filter_mode: str | None = None,
    filter_debounce_ms: int | None = None,
    api_url: str | None = None,
    id: str | None = None,
    **attributes: Any,
) -> dict[str, Any]:
    """Render ``<sample-sift>`` for a registered spatial collection."""
    unknown = set(attributes) - {"class"}
    if unknown:
        raise template.TemplateSyntaxError(f"Unknown samplesift arguments: {', '.join(sorted(unknown))}.")

    if filter_mode not in (None, "auto", "manual"):
        raise template.TemplateSyntaxError("samplesift filter_mode must be 'auto' or 'manual'.")

    name = registry.get_collection(collection).api_name()
    config = get_settings()
    include_script = not context.render_context.get(_SCRIPT_RENDERED, False)
    context.render_context[_SCRIPT_RENDERED] = True

    return {
        "include_script": include_script,
        "api_url": api_url or _api_root(),
        "collection": name,
        # The tile endpoint names its MVT layer after the collection's API name.
        "tile_layer": name,
        "page_size": min(page_size or config.default_page_size, config.max_page_size),
        "filter_mode": filter_mode,
        "filter_debounce_ms": filter_debounce_ms,
        "id": id,
        "class": attributes.get("class"),
    }
