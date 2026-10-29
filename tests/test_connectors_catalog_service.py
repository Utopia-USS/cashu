"""The connector catalog in the app (core/connectors/catalog.py): the entry rules on synthetic catalogs.

The repository's own catalog (connectors/) is tested by tests/test_connector_catalog.py, outside the
default run; these tests never depend on what the real catalog contains.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from connector_support import FETCH_MANIFEST, FILE_MANIFEST, write_connector

from cashu.core.connectors import catalog

TODAY = dt.date(2026, 10, 29)
CATALOG_FIELDS = "maintainer: \"@octocat\"\nlast_verified: {date}\n"


def catalog_entry(
    root: Path,
    cid: str = "test-conn",
    *,
    kind: str = "file",
    verified: str = "2026-10-01",
    fields: bool = True,
    readme: bool = True,
    fixtures: dict[str, str] | None = None,
) -> Path:
    template = FILE_MANIFEST if kind == "file" else FETCH_MANIFEST
    text = template.format(id=cid, module="investments", timeout=60)
    if fields:
        text += CATALOG_FIELDS.format(date=verified)
    extra = {"README.md": "# Test connector\n\nSynthetic.\n"} if readme else {}
    if fixtures is None:
        fixtures = {"fixtures/sample.csv" if kind == "file" else "fixtures/response.json": "a;b\n"}
    extra.update(fixtures)
    return write_connector(root / cid, cid=cid, kind=kind, manifest=text, extra=extra)


def test_a_complete_entry_is_valid(tmp_path):
    entry = catalog.read_entry(catalog_entry(tmp_path), today=TODAY)
    assert entry.valid and entry.problems == ()
    assert entry.manifest.maintainer == "@octocat"
    assert [p.name for p in entry.fixtures] == ["sample.csv"]
    assert len(entry.content_sha256) == 64
    assert not entry.stale(TODAY)


def test_fetch_entries_use_json_fixtures(tmp_path):
    entry = catalog.read_entry(catalog_entry(tmp_path, kind="fetch"), today=TODAY)
    assert entry.valid, entry.problems
    assert [p.name for p in entry.fixtures] == ["response.json"]


def test_catalog_fields_readme_and_fixtures_are_required(tmp_path):
    root = catalog_entry(tmp_path, fields=False, readme=False, fixtures={"fixtures/notes.txt": "x"})
    problems = catalog.read_entry(root, today=TODAY).problems
    assert any(p.startswith("maintainer: required") for p in problems), problems
    assert any(p.startswith("last_verified: required") for p in problems), problems
    assert any(p.startswith("README.md: required") for p in problems), problems
    assert any(p.startswith("fixtures/: needs at least one") for p in problems), problems


def test_directory_name_must_be_the_id(tmp_path):
    root = catalog_entry(tmp_path, "test-conn")
    moved = root.rename(tmp_path / "other-name")
    problems = catalog.read_entry(moved, today=TODAY).problems
    assert any("directory name must be the connector id" in p for p in problems), problems


def test_future_verification_dates_are_refused(tmp_path):
    root = catalog_entry(tmp_path, verified="2026-12-01")
    assert any("future" in p for p in catalog.read_entry(root, today=TODAY).problems)


def test_an_invalid_manifest_is_reported_not_raised(tmp_path):
    root = catalog_entry(tmp_path)
    (root / "connector.yaml").write_text("api_version: 1\nid: test-conn\n", encoding="utf-8")
    entry = catalog.read_entry(root, today=TODAY)
    assert entry.manifest is None and not entry.valid and entry.problems
    (root / ".hidden").write_text("x", encoding="utf-8")
    assert any("hidden" in p for p in catalog.read_entry(root, today=TODAY).problems)


def test_staleness_after_180_days():
    assert not catalog.is_stale(TODAY - dt.timedelta(days=180), TODAY)
    assert catalog.is_stale(TODAY - dt.timedelta(days=181), TODAY)
    assert catalog.is_stale(None, TODAY)


def test_entry_dirs_skip_files_and_hidden_or_cache_dirs(tmp_path):
    catalog_entry(tmp_path, "b-conn")
    catalog_entry(tmp_path, "a-conn")
    (tmp_path / "README.md").write_text("x", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / "__pycache__").mkdir()
    assert [p.name for p in catalog.entry_dirs(tmp_path)] == ["a-conn", "b-conn"]
    assert catalog.entry_dirs(tmp_path / "missing") == []
