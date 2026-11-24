"""Check that Python distributions contain the freshly built Django and Jupyter frontends.

Run after ``task build``:
    python scripts/check-python-package.py [dist-directory]

Uses only the standard library and never extracts archive members to disk.
"""

from __future__ import annotations

import argparse
import json
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src/samplesift"
COMPONENTS = "django/static/samplesift/components/"
JUPYTER = "jupyter/static/dist/"
REQUIRED = (
    JUPYTER + "widget.js",
    JUPYTER + "widget.js.map",
    JUPYTER + "THIRD_PARTY_NOTICES.txt",
    JUPYTER + "LICENSE",
    JUPYTER + "build-info.json",
    "jupyter/static/widget.js",
    COMPONENTS + "sample-sift.js",
    COMPONENTS + "data.js",
    COMPONENTS + "THIRD_PARTY_NOTICES.txt",
    COMPONENTS + "LICENSE",
    COMPONENTS + "build-info.json",
    "django/static/samplesift/tile-preview.js",
    "django/templates/samplesift/sample_sift.html",
)


def expected_files() -> dict[str, bytes]:
    files = {
        path.relative_to(PACKAGE).as_posix(): path.read_bytes()
        for directory in (COMPONENTS, JUPYTER)
        for path in (PACKAGE / directory).rglob("*")
        if path.is_file()
    }
    for name in REQUIRED:
        path = PACKAGE / name
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(
                f"Missing or empty {path.relative_to(ROOT)}; run task build first."
            )
        files[name] = path.read_bytes()

    if not any(Path(name).match("maplibre-gl-worker-*.js") for name in files):
        raise ValueError(
            "Django frontend has no MapLibre worker; run task build first."
        )

    package = json.loads(
        (ROOT / "frontend/packages/components/package.json").read_text()
    )
    for directory in (COMPONENTS, JUPYTER):
        info = json.loads(files[directory + "build-info.json"])
        if not isinstance(info, dict) or any(
            info.get(key) != package[key] for key in ("name", "version")
        ):
            raise ValueError(
                "build-info.json name/version does not match the frontend package; rebuild it."
            )
        if "sourceRevision" not in info or not (
            info["sourceRevision"] is None
            or isinstance(info["sourceRevision"], str)
            and info["sourceRevision"]
        ):
            raise ValueError(
                "build-info.json sourceRevision must be a non-empty string or null."
            )
        if "sourceDirty" not in info or not (
            info["sourceDirty"] is None or isinstance(info["sourceDirty"], bool)
        ):
            raise ValueError("build-info.json sourceDirty must be a boolean or null.")
    return files


def archive_files(path: Path) -> tuple[str, dict[str, bytes]]:
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            members = [member for member in archive.infolist() if not member.is_dir()]
            names = [member.filename for member in members]
            if len(names) != len(set(names)):
                raise ValueError(f"{path.name} contains duplicate archive paths.")
            return "samplesift/", {
                member.filename: archive.read(member) for member in members
            }
    with tarfile.open(path, "r:gz") as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError(f"{path.name} contains duplicate archive paths.")
        roots = {name.split("/", 1)[0] for name in names}
        if len(roots) != 1:
            raise ValueError(f"{path.name} must have one source distribution root.")
        files = {}
        for member in members:
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError(f"Cannot read {member.name} from {path.name}.")
            files[member.name] = stream.read()
        return f"{roots.pop()}/src/samplesift/", files


def check_archive(path: Path, expected: dict[str, bytes]) -> None:
    prefix, files = archive_files(path)
    for name, content in expected.items():
        packaged = files.get(prefix + name)
        if packaged is None:
            raise ValueError(f"{path.name} is missing {name}.")
        if packaged != content:
            raise ValueError(f"{path.name} has stale or changed bytes in {name}.")
    bundled = {
        name.removeprefix(prefix)
        for name in files
        if name.startswith(
            tuple(prefix + directory for directory in (COMPONENTS, JUPYTER))
        )
    }
    generated = {name for name in expected if name.startswith((COMPONENTS, JUPYTER))}
    if bundled != generated:
        extras = ", ".join(sorted(bundled - generated))
        raise ValueError(f"{path.name} contains unexpected frontend assets: {extras}.")
    print(
        f"Checked {path.name}: {len(generated)} frontend files match; worker, template, notices and build info included."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "dist",
        nargs="?",
        type=Path,
        default=ROOT / "dist",
        help="directory containing one wheel and one sdist",
    )
    args = parser.parse_args()
    try:
        wheels = sorted(args.dist.glob("*.whl"))
        sdists = sorted(args.dist.glob("*.tar.gz"))
        if len(wheels) != 1 or len(sdists) != 1:
            raise ValueError(
                f"Expected exactly one wheel and one sdist in {args.dist}."
            )
        expected = expected_files()
        for archive in [*wheels, *sdists]:
            check_archive(archive, expected)
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"Python package check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
