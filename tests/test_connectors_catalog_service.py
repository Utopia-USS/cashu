"""The connector catalog in the app (core/connectors/catalog.py): the entry rules on synthetic catalogs.

The repository's own catalog (connectors/) is tested by tests/test_connector_catalog.py, outside the
default run; these tests never depend on what the real catalog contains.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from connector_support import FETCH_MANIFEST, FILE_MANIFEST, needs_python3, write_connector
from sqlmodel import select

from cashu.core.connectors import catalog, runner, service
from cashu.core.connectors.models import Connector, ConnectorRun
from cashu.core.db import get_session

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


# --------------------------------------------------------------------------- #
# The catalog in the app: location, listing, install as pending (never approved)
# --------------------------------------------------------------------------- #


class Forbidden:
    """A sandbox that fails the test when anything tries to run."""

    name = "forbidden"

    def run(self, spec):  # pragma: no cover - must never be called
        raise AssertionError("a catalog call ran a connector")


@pytest.fixture
def shelf(tmp_path, monkeypatch, db_engine):
    """A synthetic catalog (two valid entries, one stale, one invalid) as the app's catalog."""
    root = tmp_path / "shelf"
    catalog_entry(root, "good-conn")
    catalog_entry(root, "old-conn", verified="2025-01-01")
    catalog_entry(root, "bad-conn", fields=False)
    (root / "README.md").write_text("# catalog\n", encoding="utf-8")
    monkeypatch.setattr(catalog, "catalog_dir", lambda: root)
    monkeypatch.setattr(runner, "default_sandbox", lambda: Forbidden())
    return root


def _row(cid: str):
    with get_session() as s:
        row = s.get(Connector, cid)
        if row is not None:
            s.expunge(row)
        return row


def test_catalog_dir_prefers_the_bundle_then_the_package_then_the_checkout(tmp_path, monkeypatch):
    from cashu.core import paths, runtime

    app = tmp_path / "cashU.app" / "Contents"
    resources = app / "Resources" / "connectors"
    frameworks = app / "Frameworks"
    resources.mkdir(parents=True)
    frameworks.mkdir()
    (frameworks / "connectors").symlink_to(resources, target_is_directory=True)
    monkeypatch.setattr(runtime, "executable", lambda: app / "MacOS" / "cashu")
    monkeypatch.setattr(runtime, "bundle_dir", lambda: frameworks)
    assert catalog.catalog_dir() == resources.resolve()
    resources.rename(app / "Resources" / "moved")  # only the bundle dir (MEIPASS) has it
    (frameworks / "connectors").unlink()
    (frameworks / "connectors").mkdir()
    assert catalog.catalog_dir() == (frameworks / "connectors").resolve()
    monkeypatch.setattr(runtime, "executable", lambda: None)
    monkeypatch.setattr(runtime, "bundle_dir", lambda: None)
    assert catalog.catalog_dir() == (paths.PROJECT_ROOT / "connectors").resolve()  # this checkout


def test_list_catalog_shows_facts_stale_and_invalid_entries(shelf):
    with get_session() as s:
        rows = {r["id"]: r for r in catalog.list_catalog(s, today=TODAY)}
    assert sorted(rows) == ["bad-conn", "good-conn", "old-conn"]
    good = rows["good-conn"]
    assert (good["module"], good["kind"], good["version"]) == ("investments", "file", "0.1.0")
    assert (good["maintainer"], good["last_verified"]) == ("@octocat", "2026-10-01")
    assert good["valid"] and not good["stale"] and good["installed"] is None
    assert len(good["content_sha256"]) == 64
    assert rows["old-conn"]["stale"] and rows["old-conn"]["valid"]
    assert not rows["bad-conn"]["valid"] and rows["bad-conn"]["problems"]


@needs_python3
def test_install_from_the_catalog_is_pending_and_pins_the_catalog_hash(shelf):
    with get_session() as s:
        listed = {r["id"]: r for r in catalog.list_catalog(s, today=TODAY)}
    done = catalog.install("good-conn")
    assert not done.replaced
    row = _row("good-conn")
    assert (row.status, row.source, row.approved_sha256) == ("pending", "catalog", None)
    assert row.content_sha256 == listed["good-conn"]["content_sha256"]
    assert (service.connectors_root() / "good-conn" / "fixtures" / "sample.csv").is_file()
    with get_session() as s:
        again = {r["id"]: r for r in catalog.list_catalog(s, today=TODAY)}
    assert again["good-conn"]["installed"] == {"status": "pending", "same_content": True}
    # Installed: a second install needs replace; replacing never approves.
    with pytest.raises(service.Conflict):
        catalog.install("good-conn")
    assert catalog.install("good-conn", replace=True).connector.status == "pending"
    # The owner approves exactly this hash; editing the installed copy stops it (changed).
    service.approve("good-conn", row.content_sha256, row.interpreter_path)
    (service.connectors_root() / "good-conn" / "main.py").write_text("print('x')\n", encoding="utf-8")
    with get_session() as s:
        after = {r["id"]: r for r in catalog.list_catalog(s, today=TODAY)}
    assert after["good-conn"]["installed"] == {"status": "changed", "same_content": False}


@needs_python3
def test_a_newer_catalog_version_over_an_approved_copy_waits_for_approval(shelf):
    row = catalog.install("good-conn").connector
    service.approve("good-conn", row.content_sha256, row.interpreter_path)
    # Reinstalling the identical content keeps the approval of that very hash (nothing new approved).
    assert catalog.install("good-conn", replace=True).connector.status == "approved"
    (shelf / "good-conn" / "main.py").write_text("print('v2')\n", encoding="utf-8")
    updated = catalog.install("good-conn", replace=True).connector
    assert updated.status == "changed" and updated.approved_sha256 == row.content_sha256
    assert updated.content_sha256 != row.content_sha256


@needs_python3
def test_invalid_or_unknown_entries_are_refused(shelf):
    with pytest.raises(service.ConnectorError) as e:
        catalog.install("bad-conn")
    assert any("maintainer" in i for i in e.value.issues)
    for cid in ("nope-conn", "../shelf", "README.md", ""):
        with pytest.raises(service.NotFound):
            catalog.install(cid)
    assert _row("bad-conn") is None


@needs_python3
def test_python_caches_are_never_hashed_or_installed(shelf):
    entry = catalog.read_entry(shelf / "good-conn", today=TODAY)
    cache = shelf / "good-conn" / "__pycache__"
    cache.mkdir()
    (cache / "main.cpython-312.pyc").write_bytes(b"\x00compiled")
    assert catalog.read_entry(shelf / "good-conn", today=TODAY).content_sha256 == entry.content_sha256
    row = catalog.install("good-conn").connector
    assert row.content_sha256 == entry.content_sha256
    assert not (service.connectors_root() / "good-conn" / "__pycache__").exists()


# --------------------------------------------------------------------------- #
# REST, MCP, CLI
# --------------------------------------------------------------------------- #


@needs_python3
def test_rest_lists_and_installs_as_pending(shelf, api_empty):
    client = api_empty
    r = client.get("/api/connectors/catalog")
    assert r.status_code == 200, r.text
    assert {e["id"] for e in r.json()} == {"bad-conn", "good-conn", "old-conn"}
    r = client.post("/api/connectors/catalog/good-conn/install")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["replaced"] is False and body["connector"]["status"] == "pending"
    assert body["connector"]["maintainer"] == "@octocat"
    assert client.post("/api/connectors/catalog/good-conn/install").status_code == 409
    r = client.post("/api/connectors/catalog/good-conn/install", json={"replace": True})
    assert r.status_code == 201 and r.json()["replaced"] is True
    assert r.json()["connector"]["status"] == "pending"
    assert client.post("/api/connectors/catalog/nope-conn/install").status_code == 404
    r = client.post("/api/connectors/catalog/bad-conn/install")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "connector_invalid"
    r = client.post("/api/connectors/catalog/good-conn/install", json={"approve": True})
    assert r.status_code == 422  # no such field: approving is POST /{id}/approve, after a look
    assert client.get("/api/connectors/good-conn").json()["status"] == "pending"


@pytest.fixture
def mcp(shelf):
    from cashu.core import profiles
    from cashu.core.mcp.server import CashuMcp

    with get_session() as s:
        p = profiles.create_profile(s, name="Anna Nowak", modules_=["investments", "budget"])
        pid = p.id
    return CashuMcp(pid)


@needs_python3
def test_mcp_lists_the_catalog_and_installs_an_entry_as_pending(mcp):
    result = mcp.call("connectors", {})
    assert result.ok, result.error
    items = {i["id"]: i for i in result.data["catalog"]}
    assert set(items) == {"bad-conn", "good-conn", "old-conn"}
    assert set(items["good-conn"]) == {
        "id", "name", "module", "kind", "version", "maintainer", "last_verified", "stale", "valid",
        "installed_status", "installed_same_content",
    }
    assert items["good-conn"]["valid"] is True and items["bad-conn"]["valid"] is False
    assert items["old-conn"]["stale"] is True
    assert "propose_connector(catalog_id" in result.data["catalog_note"]
    blob = json.dumps(result.data)
    assert "problems" not in blob and "api.example.com" not in blob

    proposed = mcp.call("propose_connector", {"catalog_id": "good-conn"})
    assert proposed.ok, proposed.error
    assert (proposed.data["id"], proposed.data["status"]) == ("good-conn", "pending")
    assert "Ustawienia > Konektory" in proposed.data["note"]
    row = _row("good-conn")
    assert (row.status, row.source, row.approved_sha256) == ("pending", "mcp", None)
    with get_session() as s:
        assert s.exec(select(ConnectorRun)).all() == []  # nothing ran
    (item,) = [i for i in mcp.call("connectors", {}).data["catalog"] if i["id"] == "good-conn"]
    assert item["installed_status"] == "pending" and item["installed_same_content"] is True


@needs_python3
def test_mcp_catalog_install_refusals(mcp, shelf):
    both = mcp.call(
        "propose_connector", {"catalog_id": "good-conn", "path": str(shelf / "good-conn")}
    )
    assert not both.ok
    assert not mcp.call("propose_connector", {}).ok
    unknown = mcp.call("propose_connector", {"catalog_id": "nope-conn"})
    assert not unknown.ok and unknown.error_kind == "not_found"
    invalid = mcp.call("propose_connector", {"catalog_id": "bad-conn"})
    assert not invalid.ok and "catalog rules" in invalid.error
    approve = mcp.call("propose_connector", {"catalog_id": "good-conn", "approve": True})
    assert not approve.ok and approve.error_kind == "invalid_arguments"
    assert _row("good-conn") is None and _row("bad-conn") is None


@needs_python3
def test_cli_catalog_list_and_add(shelf, monkeypatch):
    from rich.console import Console
    from typer.testing import CliRunner

    from cashu import cli as cli_mod
    from cashu.core import cliutil

    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=220, color_system=None, stderr=True))
    run = CliRunner()
    listed = run.invoke(cli_mod.app, ["connectors", "catalog", "list"], catch_exceptions=False)
    assert listed.exit_code == 0, listed.output
    assert "good-conn" in listed.output and "invalid entry" in listed.output
    assert "(stale)" in listed.output
    added = run.invoke(
        cli_mod.app, ["connectors", "catalog", "add", "good-conn"], catch_exceptions=False
    )
    assert added.exit_code == 0, added.output
    assert "status pending" in added.output and "Ustawienia > Konektory" in added.output
    assert _row("good-conn").source == "catalog"
