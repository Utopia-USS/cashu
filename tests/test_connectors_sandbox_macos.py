"""The real macOS sandbox (sandbox-exec + the generated deny-default profile) with real interpreters:
reads outside the allowed places, writes outside the run dir and the network are denied; a fetch run
reaches only the egress proxy, which tunnels only allowed hosts (F10). Synthetic data only."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import sys
import threading
from pathlib import Path

import pytest
from connector_support import needs_python3, target_of, write_connector

from cashu.core.connectors import manifest as mf
from cashu.core.connectors import proxy as px
from cashu.core.connectors import runner
from cashu.core.connectors.runner import InputFile, RunTarget, execute
from cashu.core.connectors.sandbox import MacSandbox

pytestmark = [
    pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox-exec only"),
    pytest.mark.skipif(not os.path.exists("/usr/bin/sandbox-exec"), reason="no sandbox-exec"),
    needs_python3,
]


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def export(tmp_path) -> InputFile:
    path = tmp_path / "exports" / "statement.csv"
    path.parent.mkdir()
    path.write_text("a,b\n1,2\n", encoding="utf-8")
    return InputFile(path, "statement.csv")


PROBE = '''\
import json, os, socket, sys
req = json.load(sys.stdin)
out = {{}}
def attempt(name, fn):
    try:
        fn()
        out[name] = "ok"
    except Exception as e:
        out[name] = type(e).__name__
attempt("read_ssh", lambda: open({ssh!r}).read())
attempt("read_data_dir", lambda: open({data_file!r}).read())
attempt("list_home", lambda: os.listdir({home!r}))
attempt("read_input", lambda: open(req["file"]["path"]).read())
attempt("read_own_dir", lambda: open({own!r}).read())
attempt("read_system", lambda: open("/etc/hosts").read())
attempt("write_outside", lambda: open({outside!r}, "w").write("x"))
attempt("write_run_dir", lambda: open("scratch.txt", "w").write("x"))
attempt("write_home_env", lambda: open(os.path.join(os.environ["HOME"], "h.txt"), "w").write("x"))
attempt("network", lambda: socket.create_connection(("127.0.0.1", {port}), timeout=3).close())
attempt("dns", lambda: socket.getaddrinfo("example.com", 443))
attempt("exec_shell", lambda: os.system("/bin/echo hi > /dev/null") == 0 or (_ for _ in ()).throw(OSError()))
print(json.dumps({{"document": {{"records": [], "probe": out}}}}))
'''


class _Listener:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            try:
                data = conn.recv(1024)
                conn.sendall(b"echo:" + data)
            finally:
                conn.close()

    def close(self):
        self.sock.close()


def test_file_connector_is_confined(tmp_path, export):
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    ssh = home / ".ssh" / "id_rsa"
    ssh.write_text("FAKE KEY", encoding="utf-8")
    data_file = tmp_path / "data" / "cashu.db"
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text("FAKE DB", encoding="utf-8")
    listener = _Listener()
    root = tmp_path / "c"
    code = PROBE.format(
        ssh=str(ssh), data_file=str(data_file), home=str(home), own=str(root / "connector.yaml"),
        outside=str(tmp_path / "outside.txt"), port=listener.port,
    )
    try:
        target = target_of(write_connector(root, code=code))
        result = execute(target, "convert", file=export, sandbox=MacSandbox())
    finally:
        listener.close()
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    probe = result.response.document["probe"]
    assert probe["read_input"] == "ok" and probe["read_own_dir"] == "ok"
    assert probe["read_system"] == "ok"
    assert probe["write_run_dir"] == "ok" and probe["write_home_env"] == "ok"
    assert probe["read_ssh"] == "PermissionError"
    assert probe["read_data_dir"] == "PermissionError"
    assert probe["list_home"] == "PermissionError"
    assert probe["write_outside"] == "PermissionError"
    assert probe["network"] in ("PermissionError", "OSError")
    assert probe["dns"] != "ok"
    assert probe["exec_shell"] != "ok"
    assert listener.accepted == 0
    assert not (tmp_path / "outside.txt").exists()


FETCH_PROBE = '''\
import json, os, socket, sys
req = json.load(sys.stdin)
proxy = os.environ["HTTPS_PROXY"].removeprefix("http://")
host, port = proxy.rsplit(":", 1)
out = {{}}
def tunnel(target):
    with socket.create_connection((host, int(port)), timeout=5) as s:
        s.sendall(("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n").encode())
        head = b""
        while b"\\r\\n\\r\\n" not in head:
            chunk = s.recv(1024)
            if not chunk:
                break
            head += chunk
        if not head.startswith(b"HTTP/1.1 200"):
            return head.split(b"\\r\\n")[0].decode()
        s.sendall(b"ping")
        return s.recv(1024).decode()
for name, target in (("allowed", "api.example.com:443"), ("other", "other.example.org:443")):
    try:
        out[name] = tunnel(target)
    except Exception as e:
        out[name] = type(e).__name__
try:
    socket.create_connection(("127.0.0.1", {direct}), timeout=3).close()
    out["direct"] = "ok"
except Exception as e:
    out["direct"] = type(e).__name__
print(json.dumps({{"document": {{"records": [], "probe": out}}, "cursor": None}}))
'''


def test_fetch_connector_reaches_only_allowed_hosts_through_the_proxy(tmp_path, monkeypatch):
    upstream = _Listener()

    async def connect(host, port):  # the "allowed host" is a local TLS-less fake
        return await asyncio.open_connection("127.0.0.1", upstream.port)

    monkeypatch.setattr(runner, "EgressProxy", lambda hosts: px.EgressProxy(hosts, connect=connect))
    code = FETCH_PROBE.format(direct=upstream.port)
    try:
        target = target_of(write_connector(tmp_path / "f", cid="test-fetch", kind="fetch", code=code))
        result = execute(target, "fetch", sandbox=MacSandbox(), secrets={"api_key": "k"},
                         since="2026-01-01")
    finally:
        upstream.close()
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    probe = result.response.document["probe"]
    assert probe["allowed"] == "echo:ping"
    assert probe["other"].startswith("HTTP/1.1 403")
    assert probe["direct"] in ("PermissionError", "OSError")  # only the proxy port is reachable
    assert upstream.accepted == 1
    assert result.denied_hosts == ["other.example.org"]
    assert (result.bytes_out, result.bytes_in) == (4, 9)


def _probe_target(tmp_path: Path, interpreter: str, script: str, code: str) -> RunTarget:
    """A target with a given interpreter (bypassing resolution) running ``script``."""
    root = write_connector(tmp_path / interpreter.replace("/", "_"), code="")
    (root / script).write_text(code, encoding="utf-8")
    manifest = mf.load_dir(root).manifest.model_copy(update={"run": ["python3", script]})
    return RunTarget(root, manifest, Path(interpreter))


PY_MINIMAL = (
    "import json, sys, ssl, decimal, datetime, csv, zipfile, urllib.request, time\n"
    "time.localtime()\n"
    "json.load(sys.stdin)\n"
    "print(json.dumps({'document': {'records': []}}))\n"
)


def test_resolved_python3_starts_under_the_profile(tmp_path, export):
    target = target_of(write_connector(tmp_path / "c", code=PY_MINIMAL))
    result = execute(target, "convert", file=export, sandbox=MacSandbox())
    assert result.ok, (str(target.interpreter), result.error_kind, result.stderr_tail)


@pytest.mark.skipif(
    not (mf.developer_dir() / "usr" / "bin" / "python3").exists(), reason="no Apple developer python3"
)
def test_apple_python3_starts_under_the_profile(tmp_path, export):
    """/usr/bin/python3 is pinned to the developer dir's real python, which runs sandboxed."""
    real = os.path.realpath(mf.developer_dir() / "usr" / "bin" / "python3")
    target = _probe_target(tmp_path, real, "main.py", PY_MINIMAL)
    result = execute(target, "convert", file=export, sandbox=MacSandbox())
    assert result.ok, (real, result.error_kind, result.stderr_tail)


@pytest.mark.skipif(shutil.which("node", path=":".join(mf.SYSTEM_SEARCH_PATH)) is None,
                    reason="no node")
def test_node_starts_under_the_profile(tmp_path, export):
    node = str(mf.resolve_interpreter("node", tmp_path))
    code = (
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{JSON.parse(d);"
        "console.log(JSON.stringify({document:{records:[]}}))});\n"
    )
    target = _probe_target(tmp_path, node, "main.js", code)
    result = execute(target, "convert", file=export, sandbox=MacSandbox())
    assert result.ok, (node, result.error_kind, result.stderr_tail)


def test_profile_runs_echo(tmp_path):
    """sandbox-exec accepts the rendered profile (a syntax error would fail every run)."""
    from cashu.core.connectors.sandbox import RunSpec

    spec = RunSpec(
        argv=("/bin/echo", "ok"), connector_dir=tmp_path, interpreter=Path("/bin/echo"),
        run_dir=tmp_path, env={"PATH": "/usr/bin:/bin"}, stdin=b"", timeout_s=10, max_stdout=1000,
    )
    outcome = MacSandbox().run(spec)
    assert outcome.error_kind is None
    assert (outcome.process.exit_code, outcome.process.stdout) == (0, b"ok\n")


def test_report_is_json_serialisable(tmp_path, export):
    """Sanity: a sandboxed convert result can be turned into the owner's run view."""
    from cashu.core.connectors.service import run_dict

    target = target_of(write_connector(tmp_path / "c", code=PY_MINIMAL))
    result = execute(target, "convert", file=export, sandbox=MacSandbox())
    json.dumps(run_dict(result))
