"""End to end on macOS (F10 BE-C3): a real fetch sync of a binding through the app's API: the
connector runs under the real ``sandbox-exec`` profile, reaches a local fake upstream only through the
egress proxy (the allow-listed host is redirected to a TLS-less local listener), its document becomes a
pending proposal, approving it imports the rows and saves the cursor. Synthetic data."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import threading

import pytest
from connector_support import memory_keyring, needs_python3, write_connector  # noqa: F401

from cashu.core.connectors import proxy as px
from cashu.core.connectors import runner, service
from cashu.core.connectors.models import ConnectorBinding
from cashu.core.connectors.sandbox import MacSandbox
from cashu.core.db import get_session

pytestmark = [
    pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox-exec only"),
    pytest.mark.skipif(not os.path.exists("/usr/bin/sandbox-exec"), reason="no sandbox-exec"),
    needs_python3,
]

DOCUMENT = {
    "format": "cashu-import", "format_version": 1, "source": "demo_api",
    "records": [
        {"record": "txn", "date": "2026-09-01", "type": "deposit", "currency": "PLN",
         "gross_amount": "100.00", "external_ref": "api-1"},
        {"record": "txn", "date": "2026-09-02", "type": "deposit", "currency": "PLN",
         "gross_amount": "50.00", "external_ref": "api-2"},
    ],
}

# Asks the egress proxy for a tunnel to the allow-listed host, sends a plain request through it (the
# fake upstream speaks no TLS) and returns what the upstream answered as the fetch document.
CONNECTOR = '''\
import json, os, socket, sys
req = json.load(sys.stdin)
host, port = os.environ["HTTPS_PROXY"].removeprefix("http://").rsplit(":", 1)
with socket.create_connection((host, int(port)), timeout=5) as s:
    s.sendall(b"CONNECT api.example.com:443 HTTP/1.1\\r\\nHost: api.example.com:443\\r\\n\\r\\n")
    head = b""
    while b"\\r\\n\\r\\n" not in head:
        head += s.recv(1024)
    if not head.startswith(b"HTTP/1.1 200"):
        print(json.dumps({"error": {"kind": "network", "message": "tunnel refused"}}))
        sys.exit(1)
    s.sendall(("GET /transactions?since=" + req["since"] + "\\n").encode())
    body = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        body += chunk
answer = json.loads(body)
print(json.dumps({"document": answer["document"], "cursor": answer["cursor"]}))
'''


class Upstream:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.requests: list[bytes] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                self.requests.append(conn.recv(1024))
                conn.sendall(json.dumps({"document": DOCUMENT, "cursor": "page-2"}).encode())

    def close(self):
        self.sock.close()


def test_real_sandboxed_fetch_through_the_proxy_becomes_a_proposal(api_empty, memory_keyring,  # noqa: F811
                                                                     tmp_path, monkeypatch):
    client = api_empty
    upstream = Upstream()

    async def connect(host, port):
        assert (host, port) == ("api.example.com", 443)
        return await asyncio.open_connection("127.0.0.1", upstream.port)

    monkeypatch.setattr(runner, "EgressProxy", lambda hosts: px.EgressProxy(hosts, connect=connect))
    monkeypatch.setattr(runner, "default_sandbox", lambda: MacSandbox())
    try:
        slug = client.post("/api/profiles", json={"name": "Jan Test", "modules": ["investments"]}).json()["slug"]
        account = client.post(f"/api/p/{slug}/investments/accounts", json={
            "name": "Broker TEST", "broker": "dif", "wrapper": "regular"}).json()["id"]
        service.install(write_connector(tmp_path / "src", cid="demo-api", kind="fetch", code=CONNECTOR))
        d = client.get("/api/connectors/demo-api").json()
        assert client.post("/api/connectors/demo-api/approve", json={
            "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]
        }).status_code == 200
        binding = client.post(f"/api/p/{slug}/connectors/bindings", json={
            "account_id": account, "connector_id": "demo-api", "secrets": {"api_key": "key-TEST"},
        }).json()["id"]
        body = client.post(f"/api/p/{slug}/connectors/bindings/{binding}/sync").json()
    finally:
        upstream.close()
    assert body["run"]["ok"] is True, body["run"]
    assert body["run"]["denied_hosts"] == [] and body["preview"]["new"] == 2
    assert upstream.requests and upstream.requests[0].startswith(b"GET /transactions?since=")
    pid = body["proposal_id"]
    assert pid
    r = client.post(f"/api/p/{slug}/proposals/{pid}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["result"]["inserted"] == 2
    with get_session() as s:
        row = s.get(ConnectorBinding, binding)
        assert row.cursor == "page-2" and row.last_ok_at is not None
