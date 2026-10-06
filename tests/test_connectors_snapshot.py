"""The approved copy (F10 BE-C3, architect decision): approving copies the connector to
``<data dir>/connectors/.approved/<id>/``; ``GET /api/connectors/{id}/diff/{relpath}`` is a unified diff of
one file between that copy and the installed one; deleting the connector removes the copy. Synthetic
data."""

from __future__ import annotations

import pytest
from connector_support import (  # noqa: F401
    ECHO_CONNECTOR,
    memory_keyring,
    needs_python3,
    write_connector,
)

from finanse.core.connectors import service

pytestmark = needs_python3


@pytest.fixture
def client(api_empty, memory_keyring):  # noqa: F811
    return api_empty


def approve(client, cid="test-conn"):
    d = client.get(f"/api/connectors/{cid}").json()
    r = client.post(f"/api/connectors/{cid}/approve", json={
        "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]})
    assert r.status_code == 200, r.text


def test_approve_keeps_a_copy_and_diff_shows_the_change(client, tmp_path):
    service.install(write_connector(tmp_path / "src", extra={"lib/util.py": "X = 1\n"}))
    assert client.get("/api/connectors/test-conn/diff/main.py").status_code == 404  # never approved
    approve(client)
    copy = service.approved_dir("test-conn")
    assert (copy / "main.py").read_text() == (tmp_path / "src" / "main.py").read_text()
    assert oct(copy.stat().st_mode & 0o777) == "0o700"
    assert not [p for p in service.approved_root().iterdir() if p.name.startswith(".")]  # no leftovers
    assert client.get("/api/connectors").json()[0]["id"] == "test-conn"  # .approved is not a connector

    installed = service.connectors_root() / "test-conn"
    (installed / "main.py").write_text(ECHO_CONNECTOR.replace("0.75", "0.95"), encoding="utf-8")
    (installed / "extra.py").write_text("NEW = True\n", encoding="utf-8")
    (installed / "lib" / "util.py").unlink()
    d = client.get("/api/connectors/test-conn").json()
    assert d["status"] == "changed"
    assert d["diff"] == {"added": ["extra.py"], "removed": ["lib/util.py"], "modified": ["main.py"]}
    r = client.get("/api/connectors/test-conn/diff/main.py")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "-    print(json.dumps({\"match\": True, \"confidence\": 0.75}))" in r.text
    assert "+    print(json.dumps({\"match\": True, \"confidence\": 0.95}))" in r.text
    assert r.text.startswith("--- zatwierdzony/main.py\n+++ obecny/main.py\n")
    added = client.get("/api/connectors/test-conn/diff/extra.py").text
    assert added.startswith("--- /dev/null\n+++ obecny/extra.py") and "+NEW = True" in added
    removed = client.get("/api/connectors/test-conn/diff/lib/util.py").text
    assert removed.startswith("--- zatwierdzony/lib/util.py\n+++ /dev/null") and "-X = 1" in removed
    assert client.get("/api/connectors/test-conn/diff/connector.yaml").text == ""  # unchanged
    assert client.get("/api/connectors/test-conn/diff/nope.py").status_code == 404
    (installed / "blob.bin").write_bytes(b"\x00\x01")
    assert client.get("/api/connectors/test-conn/diff/blob.bin").status_code == 415

    # approving again replaces the copy; deleting removes it
    (installed / "blob.bin").unlink()
    approve(client)
    assert (copy / "extra.py").is_file() and not (copy / "lib" / "util.py").exists()
    assert client.delete("/api/connectors/test-conn").status_code == 200
    assert not copy.exists()


def test_disable_keeps_the_copy(client, tmp_path):
    service.install(write_connector(tmp_path / "src"))
    approve(client)
    client.post("/api/connectors/test-conn/disable")
    assert service.approved_dir("test-conn").is_dir()
