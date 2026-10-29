"""The community connector catalog (`connectors/<id>/`, see connectors/README.md) passes its own rules.

Marked ``catalog`` and deselected from the default run (pyproject ``addopts``): a broken or stale
community connector must never block a core pull request. CI runs it in the informational
``connectors-catalog`` job on macOS; locally: ``pytest -m catalog tests/test_connector_catalog.py``.

For every entry: the manifest and the directory are valid, the catalog fields (maintainer,
last_verified, README.md, fixtures/) are present, ``last_verified`` is not older than 180 days, and
``cashu connectors test`` (the devtest path, in the real macOS sandbox the app uses) passes on every
fixture. Where connectors cannot run (no macOS sandbox) the fixture runs are skipped.
"""

from __future__ import annotations

import os
import sys

import pytest

from cashu.core import paths
from cashu.core.connectors import catalog, devtest
from cashu.core.connectors import manifest as mf

pytestmark = pytest.mark.catalog

CATALOG = paths.PROJECT_ROOT / "connectors"
ENTRIES = catalog.entry_dirs(CATALOG)
IDS = [p.name for p in ENTRIES]

can_run_connectors = pytest.mark.skipif(
    sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"),
    reason="connectors run only in the macOS sandbox",
)


def _fixture_cases() -> list:
    cases = []
    for root in ENTRIES:
        entry = catalog.read_entry(root)
        for fixture in entry.fixtures:
            cases.append(pytest.param(root, fixture, id=f"{root.name}/{fixture.name}"))
    return cases


def test_the_catalog_has_a_readme_and_entries():
    assert (CATALOG / "README.md").is_file()
    assert ENTRIES, "connectors/ has no entries"


@pytest.mark.parametrize("root", ENTRIES, ids=IDS)
def test_entry_follows_the_catalog_rules(root):
    entry = catalog.read_entry(root)
    assert entry.manifest is not None, f"invalid manifest or directory: {entry.problems}"
    assert not entry.problems, entry.problems


@pytest.mark.parametrize("root", ENTRIES, ids=IDS)
def test_entry_is_not_stale(root):
    entry = catalog.read_entry(root)
    if entry.manifest is None:
        pytest.skip("invalid manifest (reported by test_entry_follows_the_catalog_rules)")
    assert not entry.stale(), (
        f"{root.name}: last_verified {entry.manifest.last_verified} is older than "
        f"{catalog.STALE_AFTER_DAYS} days: the entry is flagged unmaintained until its maintainer "
        "checks it again"
    )


@can_run_connectors
@pytest.mark.parametrize(("root", "fixture"), _fixture_cases())
def test_fixture_passes_connectors_test(root, fixture):
    entry = catalog.read_entry(root)
    try:
        mf.load_dir(root)
    except mf.ManifestError as e:
        missing = [i for i in e.issues if "was not found" in i or "developer tools" in i]
        if missing:  # the runner lacks the interpreter: not the connector's fault
            pytest.skip("; ".join(missing))
    if entry.manifest.kind == "file":
        report = devtest.run_test(root, file=fixture)
    else:
        report = devtest.run_test(root, fixture=fixture)
    assert report.ok, report.text()
