"""Backend-independent queryable descriptors."""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Queryable:
    name: str
    schema: dict[str, Any]
    operators: tuple[str, ...]
    annotations: dict[str, Any] = field(default_factory=dict)

    def json_schema(self) -> dict[str, Any]:
        result = {**self.schema, "x-samplesift": {"operators": list(self.operators), **self.annotations}}
        return result
