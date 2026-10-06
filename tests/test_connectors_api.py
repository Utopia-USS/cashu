"""Connector registry, approval API and fetch bindings (F10): install never approves, approval pins
hash + interpreter (409 on mismatch), changed / disabled connectors never run, delete removes bindings,
secrets and runs, secrets are write-only. Synthetic data, in-memory keyring, NoSandbox."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from connector_support import (  # noqa: F401  (fixture)
    NoSandbox,
    memory_keyring,
    needs_python3,
    write_connector,
)
from sqlmodel import select

from finanse.core import secrets
from finanse.core.connectors import manifest as mf
from finanse.core.connectors import runner, service
from finanse.core.connectors.models import Connector, ConnectorBinding, ConnectorRun
from finanse.core.db import get_session

pytestmark = needs_python3

SECRET = "sk-live-TEST-0123456789abcdefXYZ"


@pytest.fixture
def client(api_empty, memory_keyring, monkeypatch):  # noqa: F811
    monkeypatch.setattr(runner, "default_sandbox", lambda: NoSandbox())
    return api_empty


def setup_profile(client, name: str = "Jan Test") -> tuple[str, int]:
    r = client.post("/api/profiles", json={"name": name, "modules": ["investments", "budget"]})
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    r = client.post(
        f"/api/p/{slug}/investments/accounts",
        json={"name": "Broker TEST", "broker": "dif", "wrapper": "regular"},
    )
    assert r.status_code == 201, r.text
    return slug, r.json()["id"]


def install(tmp_path: Path, **kw) -> Connector:
    name = kw.pop("dirname", kw.get("cid", "test-conn"))
    return service.install(write_connector(tmp_path / "src" / name, **kw)).connector


def approve(client, cid: str) -> dict:
    d = client.get(f"/api/connectors/{cid}").json()
    r = client.post(f"/api/connectors/{cid}/approve", json={
        "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"],
    })
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# Install, list, detail, files
# --------------------------------------------------------------------------- #


def test_install_is_pending_and_copied_privately(client, tmp_path):
    c = install(tmp_path, extra={"lib/helper.py": "X = 1\n"})
    assert c.status == "pending" and c.source == "cli"
    installed = service.connectors_root() / "test-conn"
    assert (installed / "lib" / "helper.py").read_text() == "X = 1\n"
    assert oct(installed.stat().st_mode & 0o777) == "0o700"
    assert oct((installed / "main.py").stat().st_mode & 0o777) == "0o600"
    assert [p.name for p in service.connectors_root().iterdir()] == ["test-conn"]  # no leftovers

    (listed,) = client.get("/api/connectors").json()
    assert (listed["id"], listed["status"], listed["bindings"], listed["last_run"]) == (
        "test-conn", "pending", 0, None)
    d = client.get("/api/connectors/test-conn").json()
    assert [f["path"] for f in d["files"]] == ["connector.yaml", "lib/helper.py", "main.py"]
    assert d["content_sha256"] == mf.content_sha256(mf.scan_dir(installed))
    assert d["interpreter_path"] == c.interpreter_path and os.path.isabs(d["interpreter_path"])
    assert d["extensions"] == ["csv"] and d["diff"] is None and d["problems"] == []


def test_install_refuses_invalid_dirs_and_duplicates(client, tmp_path):
    bad = write_connector(tmp_path / "bad", manifest="api_version: 1\nid: Bad\n")
    with pytest.raises(service.ConnectorError) as e:
        service.install(bad)
    assert e.value.issues
    install(tmp_path)
    with pytest.raises(service.Conflict, match="already installed"):
        install(tmp_path, dirname="again")
    with pytest.raises(service.Conflict, match="module or kind"):
        service.install(write_connector(tmp_path / "x", module="budget"), replace=True)


def test_file_viewer(client, tmp_path):
    install(tmp_path, extra={"data.bin": "", "big.txt": "x" * (service.MAX_VIEW_BYTES + 1)})
    (service.connectors_root() / "test-conn" / "data.bin").write_bytes(b"\x00\x01\x02")
    r = client.get("/api/connectors/test-conn/files/main.py")
    assert r.status_code == 200 and "json.load(sys.stdin)" in r.text
    assert r.headers["content-type"].startswith("text/plain")
    # the binary file changed the installed content: still viewable as metadata, but refused as text
    assert client.get("/api/connectors/test-conn/files/data.bin").status_code == 415
    assert client.get("/api/connectors/test-conn/files/big.txt").status_code == 413
    assert client.get("/api/connectors/test-conn/files/nope.py").status_code == 404
    assert client.get("/api/connectors/test-conn/files/..%2F..%2Ffinanse.db").status_code == 404
    assert client.get("/api/connectors/nope/files/main.py").status_code == 404


def test_routes_need_the_token(api_empty, tmp_path):
    from fastapi.testclient import TestClient

    from finanse.api.app import app
    from finanse.core import security

    raw = TestClient(app, base_url=security.get_config().base_url)
    assert raw.get("/api/connectors").status_code in (401, 403)
    assert raw.post("/api/connectors/x/approve", json={}).status_code in (401, 403)


# --------------------------------------------------------------------------- #
# Approval, change detection, runs
# --------------------------------------------------------------------------- #


def test_approve_pins_hash_and_interpreter_409_on_mismatch(client, tmp_path):
    install(tmp_path)
    d = client.get("/api/connectors/test-conn").json()
    wrong_sha = client.post("/api/connectors/test-conn/approve", json={
        "content_sha256": "0" * 64, "interpreter_path": d["interpreter_path"]})
    assert wrong_sha.status_code == 409
    assert wrong_sha.headers["X-Finanse-Error-Code"] == "connector_changed"
    wrong_interp = client.post("/api/connectors/test-conn/approve", json={
        "content_sha256": d["content_sha256"], "interpreter_path": "/usr/bin/false"})
    assert wrong_interp.status_code == 409
    assert client.post("/api/connectors/nope/approve", json={
        "content_sha256": "x", "interpreter_path": "y"}).status_code == 404
    out = approve(client, "test-conn")
    assert out["status"] == "approved" and out["approved_at"]
    with get_session() as s:
        row = s.get(Connector, "test-conn")
        assert row.approved_sha256 == d["content_sha256"]
        assert row.approved_interpreter == d["interpreter_path"]


def test_approved_connector_runs_and_is_recorded(client, tmp_path):
    install(tmp_path)
    export = tmp_path / "e.csv"
    export.write_text("a\n1\n", encoding="utf-8")
    refused = service.run_file("test-conn", "convert", export, "e.csv")
    assert (refused.outcome, refused.error_kind) == ("refused", "not_approved")
    approve(client, "test-conn")
    ok = service.run_file("test-conn", "convert", export, "e.csv")
    assert ok.ok and ok.records == 2 and ok.run_id
    with get_session() as s:
        runs = s.exec(select(ConnectorRun).order_by(ConnectorRun.id)).all()
    assert [(r.command, r.outcome, r.error_kind) for r in runs] == [
        ("convert", "refused", "not_approved"), ("convert", "ok", None)]
    assert runs[1].records == 2 and runs[1].profile_id is None
    last = client.get("/api/connectors").json()[0]["last_run"]
    assert (last["command"], last["outcome"]) == ("convert", "ok")
    recent = client.get("/api/connectors/test-conn").json()["recent_runs"]
    assert [(r["outcome"], r["records"]) for r in recent] == [("ok", 2), ("refused", 0)]


def test_changed_file_flips_status_and_refuses_to_run(client, tmp_path):
    install(tmp_path)
    approve(client, "test-conn")
    installed = service.connectors_root() / "test-conn"
    (installed / "main.py").write_text("print('evil')\n", encoding="utf-8")
    (installed / "extra.py").write_text("", encoding="utf-8")
    d = client.get("/api/connectors/test-conn").json()
    assert d["status"] == "changed"
    assert d["diff"] == {"added": ["extra.py"], "removed": [], "modified": ["main.py"]}
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    result = service.run_file("test-conn", "convert", export, "e.csv")
    assert (result.outcome, result.error_kind) == ("refused", "not_approved")
    # approving the new content (after looking at it) makes it runnable again
    approve(client, "test-conn")
    assert service.run_file("test-conn", "detect", export, "e.csv").outcome == "failed"  # evil code


def test_interpreter_change_flips_status(client, tmp_path, monkeypatch):
    install(tmp_path)
    approve(client, "test-conn")
    original = mf.resolve_interpreter
    other = tmp_path / "other-python"
    other.write_text("", encoding="utf-8")
    other.chmod(0o755)
    monkeypatch.setattr(mf, "resolve_interpreter", lambda argv0, root, home=None: other)
    d = client.get("/api/connectors/test-conn").json()
    assert d["status"] == "changed" and d["interpreter_changed"] is True
    assert d["interpreter_path"] == str(other)
    gate = service.runnable("test-conn")
    assert gate.error_kind == "interpreter_changed"
    monkeypatch.setattr(mf, "resolve_interpreter", original)
    approve(client, "test-conn")
    assert not isinstance(service.runnable("test-conn"), runner.RunResult)


def test_replace_resets_approval_unless_identical(client, tmp_path):
    src = write_connector(tmp_path / "src" / "c")
    service.install(src)
    approve(client, "test-conn")
    same = service.install(src, replace=True)
    assert same.replaced and same.connector.status == "approved"
    (src / "main.py").write_text("print('v2')\n", encoding="utf-8")
    changed = service.install(src, replace=True)
    assert changed.connector.status == "changed"
    assert client.get("/api/connectors/test-conn").json()["diff"]["modified"] == ["main.py"]


def test_missing_dir_refuses(client, tmp_path):
    import shutil

    install(tmp_path)
    approve(client, "test-conn")
    shutil.rmtree(service.connectors_root() / "test-conn")
    d = client.get("/api/connectors/test-conn").json()
    assert d["missing"] and d["status"] == "changed"
    assert service.runnable("test-conn").error_kind == "missing"


def test_disable_stops_runs_and_keeps_bindings(client, tmp_path):
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    b = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": account, "connector_id": "test-fetch", "secrets": {"api_key": SECRET}})
    assert b.status_code == 201, b.text
    assert client.post("/api/connectors/test-fetch/disable").json()["status"] == "disabled"
    check = client.post(f"/api/p/{slug}/connectors/bindings/{b.json()['id']}/check").json()
    assert (check["outcome"], check["error_kind"]) == ("refused", "not_approved")
    assert len(client.get(f"/api/p/{slug}/connectors/bindings").json()) == 1
    approve(client, "test-fetch")  # approving again enables it
    check = client.post(f"/api/p/{slug}/connectors/bindings/{b.json()['id']}/check").json()
    assert check["ok"] is True


def test_delete_removes_dir_bindings_secrets_and_runs(client, tmp_path, memory_keyring):  # noqa: F811
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    b = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": account, "connector_id": "test-fetch", "secrets": {"api_key": SECRET}}).json()
    client.post(f"/api/p/{slug}/connectors/bindings/{b['id']}/check")
    assert any(SECRET == v for v in memory_keyring.store.values())
    r = client.delete("/api/connectors/test-fetch")
    assert r.status_code == 200 and r.json() == {"ok": True, "bindings": 1, "secrets_left": 0}
    assert memory_keyring.store == {}
    assert not (service.connectors_root() / "test-fetch").exists()
    with get_session() as s:
        assert s.exec(select(ConnectorBinding)).all() == []
        assert s.exec(select(ConnectorRun)).all() == []
        assert s.get(Connector, "test-fetch") is None
    assert client.get("/api/connectors/test-fetch").status_code == 404


def test_runs_are_pruned_per_connector(client, tmp_path, monkeypatch):
    monkeypatch.setattr(service, "KEEP_RUNS", 3)
    install(tmp_path)
    for _ in range(5):
        service.run("test-conn", "convert")  # refused (pending): recorded all the same
    with get_session() as s:
        ids = s.exec(select(ConnectorRun.id).order_by(ConnectorRun.id)).all()
    assert len(ids) == 3 and ids == sorted(ids)


# --------------------------------------------------------------------------- #
# Bindings
# --------------------------------------------------------------------------- #


def test_binding_crud_and_write_only_secrets(client, tmp_path, memory_keyring):  # noqa: F811
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    base = f"/api/p/{slug}/connectors/bindings"
    r = client.post(base, json={
        "account_id": account, "connector_id": "test-fetch",
        "params": {"start": "2026-01-01"}, "secrets": {"api_key": SECRET},
    })
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["secrets_set"] == ["api_key"] and b["params"] == {"start": "2026-01-01"}
    assert b["auto_commit"] is False and b["has_cursor"] is False
    name = secrets.connector_secret_name("test-fetch", slug, b["id"], "api_key")
    assert memory_keyring.store[("finanse", name)] == SECRET

    dup = client.post(base, json={"account_id": account, "connector_id": "test-fetch"})
    assert dup.status_code == 409
    assert dup.headers["X-Finanse-Error-Code"] == "connector_binding_exists"

    upd = client.put(f"{base}/{b['id']}", json={"auto_commit": True, "params": {}})
    assert upd.status_code == 200 and upd.json()["auto_commit"] is True and upd.json()["params"] == {}
    bad = client.put(f"{base}/{b['id']}", json={"params": {"start": "01.01.2026"}})
    assert bad.status_code == 422 and bad.headers["X-Finanse-Error-Code"] == "connector_params"
    assert bad.json()["detail"]["params"] == {"start": "must be a date YYYY-MM-DD"}
    assert client.put(f"{base}/{b['id']}", json={"params": {"nope": 1}}).status_code == 422

    cleared = client.put(f"{base}/{b['id']}/secrets", json={"secrets": {"api_key": None}})
    assert cleared.json() == {"secrets_set": []}
    again = client.put(f"{base}/{b['id']}/secrets", json={"secrets": {"api_key": "new-" + SECRET}})
    assert again.json() == {"secrets_set": ["api_key"]}
    assert client.put(f"{base}/{b['id']}/secrets", json={"secrets": {"other": "x"}}).status_code == 422

    # no endpoint ever returns a secret value
    for path in (base, f"{base}/{b['id']}", "/api/connectors", "/api/connectors/test-fetch"):
        assert SECRET not in client.get(path).text, path

    gone = client.delete(f"{base}/{b['id']}")
    assert gone.status_code == 200 and memory_keyring.store == {}
    assert client.get(f"{base}/{b['id']}").status_code == 404


def test_binding_rules(client, tmp_path):
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    install(tmp_path, cid="test-file")
    base = f"/api/p/{slug}/connectors/bindings"
    file_kind = client.post(base, json={"account_id": account, "connector_id": "test-file"})
    assert file_kind.status_code == 422
    # a connector the owner has not approved cannot be bound (design C3)
    pending = client.post(base, json={"account_id": account, "connector_id": "test-fetch"})
    assert pending.status_code == 422
    assert pending.headers["X-Finanse-Error-Code"] == "connector_not_approved"
    approve(client, "test-fetch")
    assert client.post(base, json={"account_id": 99999, "connector_id": "test-fetch"}).status_code == 404
    assert client.post(base, json={"account_id": account, "connector_id": "nope"}).status_code == 404
    # a budget connector needs a bank account, not a brokerage one
    install(tmp_path, cid="budget-fetch", kind="fetch", module="budget")
    approve(client, "budget-fetch")
    wrong = client.post(base, json={"account_id": account, "connector_id": "budget-fetch"})
    assert wrong.status_code == 422 and "bank account" in wrong.json()["detail"]
    # unknown body keys are refused
    assert client.post(base, json={"account_id": account, "connector_id": "test-fetch",
                                   "secret": "x"}).status_code == 422


def test_bindings_are_isolated_per_profile(client, tmp_path):
    slug, account = setup_profile(client, "Anna Test")
    other, other_account = setup_profile(client, "Piotr Test")
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    b = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": account, "connector_id": "test-fetch"}).json()
    assert client.get(f"/api/p/{other}/connectors/bindings").json() == []
    for method, path, body in (
        ("get", f"/api/p/{other}/connectors/bindings/{b['id']}", None),
        ("put", f"/api/p/{other}/connectors/bindings/{b['id']}", {"auto_commit": True}),
        ("put", f"/api/p/{other}/connectors/bindings/{b['id']}/secrets", {"secrets": {"api_key": "x"}}),
        ("post", f"/api/p/{other}/connectors/bindings/{b['id']}/check", None),
        ("delete", f"/api/p/{other}/connectors/bindings/{b['id']}", None),
    ):
        r = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert r.status_code == 404, (method, path, r.status_code)
    # another profile's account cannot be bound either
    cross = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": other_account, "connector_id": "test-fetch"})
    assert cross.status_code == 404
    assert client.get("/api/connectors/bindings").status_code in (404, 405)  # no legacy alias


def test_check_runs_with_secrets_on_stdin_only(client, tmp_path, monkeypatch):
    sandbox = NoSandbox()
    monkeypatch.setattr(runner, "default_sandbox", lambda: sandbox)
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    b = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": account, "connector_id": "test-fetch", "secrets": {"api_key": SECRET},
        "params": {"start": "2026-02-01"}}).json()
    r = client.post(f"/api/p/{slug}/connectors/bindings/{b['id']}/check")
    assert r.status_code == 200 and r.json()["ok"] is True
    spec = sandbox.specs[-1]
    request = json.loads(spec.stdin)
    assert request["secrets"] == {"api_key": SECRET} and request["params"] == {"start": "2026-02-01"}
    assert request["account"] == {"currency": "PLN", "label": "Broker TEST"}
    assert SECRET not in " ".join(spec.argv) and SECRET not in json.dumps(dict(spec.env))
    after = client.get(f"/api/p/{slug}/connectors/bindings/{b['id']}").json()
    assert after["last_status"] == "ok" and after["last_run_at"] is None  # check: no attempt (BE-4)
    with get_session() as s:
        run = s.exec(select(ConnectorRun)).one()
        assert (run.command, run.binding_id) == ("check", b["id"])
        assert SECRET not in json.dumps(run.model_dump(mode="json"))


def test_run_fetch_seam_does_not_save_the_cursor(client, tmp_path):
    slug, account = setup_profile(client)
    install(tmp_path, cid="test-fetch", kind="fetch")
    approve(client, "test-fetch")
    b = client.post(f"/api/p/{slug}/connectors/bindings", json={
        "account_id": account, "connector_id": "test-fetch"}).json()
    with get_session() as s:
        from finanse.core import profiles

        profile = profiles.get_by_slug(s, slug)
    out = service.run_fetch(profile, b["id"], sandbox=NoSandbox())
    assert out.result.ok and out.cursor == "c1" and len(out.document["records"]) == 2
    import datetime as dt

    assert out.since == (dt.datetime.now(dt.UTC).astimezone().date() - dt.timedelta(days=30)).isoformat()
    with get_session() as s:
        row = s.get(ConnectorBinding, b["id"])
        assert row.cursor is None and row.last_run_at is not None and row.last_status == "ok"


def test_secret_namespace():
    name = secrets.connector_secret_name("xtb-api", "jan", 3, "api_key")
    assert name == "connector/xtb-api/jan/3/api_key"
    for bad in (("X", "jan", 1, "k"), ("xtb", "Jan Kowalski", 1, "k"), ("xtb", "jan", 0, "k"),
                ("xtb", "jan", 1, "Key"), ("xtb", "jan", True, "k"), ("xtb/../a", "jan", 1, "k")):
        with pytest.raises(ValueError):
            secrets.connector_secret_name(*bad)
    with pytest.raises(ValueError):
        secrets.get_secret(name)  # the global allowlist never accepts connector names
    with pytest.raises(ValueError):
        secrets.get_connector_secret("anthropic")
    with pytest.raises(ValueError):
        secrets.set_connector_secret("connector/a/b/c/d", "x")


def test_disabled_connector_reports_content_changed_and_diff(client, tmp_path):
    """FE-5: a disabled connector edited on disk keeps ``disabled`` but says so (flag + diff); approving
    it again needs the current hash."""
    src = write_connector(tmp_path / "src" / "c")
    service.install(src)
    approve(client, "test-conn")
    client.post("/api/connectors/test-conn/disable")
    d = client.get("/api/connectors/test-conn").json()
    assert (d["status"], d["content_changed"], d["diff"]) == ("disabled", False, None)

    (service.connectors_root() / "test-conn" / "main.py").write_text("print('v2')\n", encoding="utf-8")
    (listed,) = client.get("/api/connectors").json()
    assert (listed["status"], listed["content_changed"]) == ("disabled", True)
    d = client.get("/api/connectors/test-conn").json()
    assert d["status"] == "disabled" and d["content_changed"] is True
    assert d["diff"] == {"added": [], "removed": [], "modified": ["main.py"]}
    assert d["content_sha256"] != d["approved_sha256"]
    assert "print('v2')" in client.get("/api/connectors/test-conn/diff/main.py").text
    stale = client.post("/api/connectors/test-conn/approve", json={
        "content_sha256": d["approved_sha256"], "interpreter_path": d["interpreter_path"]})
    assert stale.status_code == 409
    assert isinstance(service.runnable("test-conn"), runner.RunResult)

    approve(client, "test-conn")  # the current hash enables it again
    d = client.get("/api/connectors/test-conn").json()
    assert (d["status"], d["content_changed"], d["diff"]) == ("approved", False, None)


def test_a_file_swapped_after_the_gate_never_runs(client, tmp_path, monkeypatch):
    """BE-15 / SEC-2: the run executes a hash-verified copy, not the live installed dir. A file
    rewritten between the approval gate and the start of the process is refused, not executed."""
    marker = tmp_path / "evil-ran"
    install(tmp_path)
    approve(client, "test-conn")
    box = NoSandbox()
    original_gate = service._gate

    def gate_then_swap(cid):
        gate = original_gate(cid)
        evil = f"open({str(marker)!r}, 'w').write('x')\n"
        (service.connectors_root() / cid / "main.py").write_text(evil, encoding="utf-8")
        return gate

    monkeypatch.setattr(service, "_gate", gate_then_swap)
    export = tmp_path / "e.csv"
    export.write_text("a,b\n", encoding="utf-8")
    result = service.run_file("test-conn", "convert", export, "e.csv", sandbox=box)
    assert (result.outcome, result.error_kind) == ("refused", "not_approved")
    assert box.specs == [] and not marker.exists()
    with get_session() as s:
        assert s.get(Connector, "test-conn").status == "changed"
    assert list(runner.runs_dir().iterdir()) == []  # the snapshot is gone


def test_runs_execute_a_snapshot_that_is_removed_afterwards(client, tmp_path):
    install(tmp_path)
    approve(client, "test-conn")
    box = NoSandbox()
    export = tmp_path / "e.csv"
    export.write_text("a,b\n", encoding="utf-8")
    assert service.run_file("test-conn", "convert", export, "e.csv", sandbox=box).ok
    (spec,) = box.specs
    installed = Path(os.path.realpath(service.connectors_root() / "test-conn"))
    assert Path(spec.connector_dir) != installed
    assert Path(spec.connector_dir).parent.parent == Path(os.path.realpath(runner.runs_dir()))
    assert Path(spec.connector_dir).parent != Path(spec.run_dir)  # never inside the writable run dir
    assert not Path(spec.connector_dir).exists()
    assert list(runner.runs_dir().iterdir()) == []
