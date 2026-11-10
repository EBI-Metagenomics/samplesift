import importlib


def test_core_package_imports_without_django_setup() -> None:
    package = importlib.import_module("samplesift")

    assert package.__name__ == "samplesift"
