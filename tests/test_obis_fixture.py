"""Check that the committed example fixture is usable and matches its provenance."""

import json
from datetime import date
from pathlib import Path


def test_obis_fixture_matches_provenance() -> None:
    directory = Path(__file__).resolve().parents[1] / "examples/obis/occurrences/fixtures"
    fixture = json.loads((directory / "obis.json").read_text())
    source = json.loads((directory / "obis-source.json").read_text())

    assert fixture
    assert len(fixture) == source["inspected"] - source["excluded"]
    assert source["inspected"] <= source["requested"]
    assert len({row["pk"] for row in fixture}) == len(fixture)
    for row in fixture:
        assert row["model"] == "occurrences.occurrence"
        assert row["pk"] and len(row["pk"]) <= 255
        fields = row["fields"]
        assert -180 <= fields["lon"] <= 180
        assert -85.05112878 <= fields["lat"] <= 85.05112878
        assert fields["depth"] >= 0
        date.fromisoformat(fields["date"])
        assert isinstance(fields["name"], str)
