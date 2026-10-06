"""Connector runs with the NoSandbox double: protocol per command, errors, caps, timeouts, clean env,
input copies; the egress proxy's allow-list and tunnel (F10). All data is synthetic."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import socket
import threading
import time
from pathlib import Path

import pytest
from connector_support import NoSandbox, needs_python3, target_of, write_connector

from finanse.core.connectors import protocol as proto
from finanse.core.connectors import proxy as px
from finanse.core.connectors import runner
from finanse.core.connectors.process import run_process
from finanse.core.connectors.runner import InputFile, execute

pytestmark = needs_python3


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def export(tmp_path) -> InputFile:
    path = tmp_path / "exports" / "statement.csv"
    path.parent.mkdir()
    path.write_text("a,b\n1,2\n", encoding="utf-8")
    return InputFile(path, "statement.csv")


def _code(body: str) -> str:
    return "import json, os, sys\nreq = json.load(sys.stdin)\n" + body


def test_file_commands_happy_path(tmp_path, export):
    target = target_of(write_connector(tmp_path / "c"))
    detect = execute(target, "detect", file=export, sandbox=NoSandbox())
    assert detect.ok and detect.response.match and detect.response.confidence == 0.75
    convert = execute(target, "convert", file=export, sandbox=NoSandbox())
    assert convert.ok and convert.records == 2 and convert.exit_code == 0
    assert convert.response.document["format"] == "finanse-import"
    assert convert.response.cursor is None


def test_fetch_and_check_happy_path(tmp_path):
    target = target_of(write_connector(tmp_path / "f", cid="test-fetch", kind="fetch"))
    sandbox = NoSandbox()
    fetch = execute(target, "fetch", sandbox=sandbox, network=False, secrets={"api_key": "k"},
                    since="2026-01-01", cursor=None)
    assert fetch.ok and fetch.response.cursor == "c1" and fetch.records == 2
    check = execute(target, "check", sandbox=sandbox, network=False, secrets={"api_key": "k"})
    assert check.ok and check.response.ok is True
    request = json.loads(sandbox.specs[0].stdin)
    assert request == {
        "api_version": 1, "command": "fetch", "module": "investments", "params": {},
        "secrets": {"api_key": "k"}, "since": "2026-01-01", "cursor": None,
    }
    assert "since" not in json.loads(sandbox.specs[1].stdin)


def test_request_shape_for_convert_and_input_is_a_copy(tmp_path, export):
    code = _code(
        "out = {'req': req, 'cwd': os.getcwd(), 'listing': sorted(os.listdir('.')),\n"
        "       'content': open(req['file']['path']).read()}\n"
        "sys.stderr.write(json.dumps(out))\n"
        "print(json.dumps({'document': {'records': []}}))\n"
    )
    sandbox = NoSandbox()
    target = target_of(write_connector(tmp_path / "c", code=code))
    result = execute(target, "convert", file=export, sandbox=sandbox,
                     account={"currency": "PLN", "label": "Konto TEST"}, params={"x": 1})
    assert result.ok, result
    spec = sandbox.specs[0]
    request = json.loads(spec.stdin)
    assert request["file"]["name"] == "statement.csv"
    assert request["file"]["path"] == str(spec.run_dir / "input.csv")
    assert str(export.path.parent) not in spec.stdin.decode()  # the original location never leaks
    assert request["account"] == {"currency": "PLN", "label": "Konto TEST"}
    assert "secrets" not in request and "cursor" not in request
    assert not spec.run_dir.exists()  # removed after the run
    assert spec.run_dir.parent == runner.runs_dir().resolve()


def test_env_is_clean(tmp_path, export, monkeypatch):
    monkeypatch.setenv("FINANSE_SECRET_PROBE", "must-not-leak")
    code = _code(
        "sys.stderr.write('ENV=' + json.dumps(dict(os.environ)))\n"
        "print(json.dumps({'document': {'records': []}}))\n"
    )
    sandbox = NoSandbox()
    target = target_of(write_connector(tmp_path / "c", code=code))
    result = execute(target, "convert", file=export, sandbox=sandbox)
    assert result.ok
    run = run_process(  # the same wrapper, read the env directly (stderr tail is scrubbed)
        list(sandbox.specs[0].argv[:1]) + ["-c", "import os, json; print(json.dumps(dict(os.environ)))"],
        env=sandbox.specs[0].env, cwd=str(tmp_path), stdin=b"", timeout_s=10, max_stdout=1 << 20,
    )
    env = json.loads(run.stdout)
    allowed = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE",
               "PYTHONNOUSERSITE", "FINANSE_CONNECTOR_API"}
    # macOS adds __CF_USER_TEXT_ENCODING to every process it starts (not inherited, not data)
    assert set(env) - {"__CF_USER_TEXT_ENCODING"} == allowed, env
    assert env["HOME"] == env["TMPDIR"] and env["PATH"].startswith("/usr/bin:/bin:")
    assert "must-not-leak" not in json.dumps(env)


def test_fetch_env_points_at_the_proxy(tmp_path):
    sandbox = NoSandbox()
    target = target_of(write_connector(tmp_path / "f", cid="test-fetch", kind="fetch"))
    result = execute(target, "check", sandbox=sandbox, secrets={"api_key": "k"})
    assert result.ok
    env = sandbox.specs[0].env
    port = sandbox.specs[0].proxy_port
    assert env["HTTPS_PROXY"] == env["HTTP_PROXY"] == f"http://127.0.0.1:{port}"
    assert env["NO_PROXY"] == ""


def test_error_object_and_secret_redaction(tmp_path):
    code = _code(
        "sys.stderr.write('using key ' + req['secrets']['api_key'] + ' for IBAN PL61109010140000071219812874')\n"
        "print(json.dumps({'error': {'kind': 'auth_failed', 'message': 'key ' + req['secrets']['api_key'] + ' rejected'}}))\n"
        "sys.exit(1)\n"
    )
    target = target_of(write_connector(tmp_path / "f", cid="test-fetch", kind="fetch", code=code))
    secret = "sk-test-0123456789abcdef"
    result = execute(target, "check", sandbox=NoSandbox(), network=False, secrets={"api_key": secret})
    assert (result.outcome, result.error_kind, result.exit_code) == ("failed", "auth_failed", 1)
    assert secret not in result.message and "[secret]" in result.message
    assert secret not in result.stderr_tail and "PL61109010140000071219812874" not in result.stderr_tail


@pytest.mark.parametrize(
    ("body", "kind"),
    [
        ("print('not json')\n", "protocol"),
        ("print(json.dumps([1, 2]))\n", "protocol"),
        ("print(json.dumps({'match': 'yes'}))\n", "protocol"),
        ("print(json.dumps({'document': {}, 'extra': 1}))\n", "protocol"),
        ("print(json.dumps({'document': {}, 'cursor': 'x'}))\n", "protocol"),  # convert has no cursor
        ("sys.exit(3)\n", "protocol"),
        ("print('{}'); sys.exit(1)\n", "protocol"),  # exit 1 without an error object
        ("print(json.dumps({'error': {'kind': 'weird_kind', 'message': 'x'}})); sys.exit(1)\n",
         "internal"),
        ("sys.stdout.buffer.write(b'\\xff\\xfe'); sys.exit(0)\n", "protocol"),
        # NaN / Infinity are not JSON numbers (BE-6 / SEC-4), neither in a document nor in detect
        ("print('{\"document\": {\"x\": NaN}}')\n", "protocol"),
        ("print('{\"document\": {\"x\": -Infinity}}')\n", "protocol"),
        ("print('{\"match\": true, \"confidence\": 1e999}')\n", "protocol"),
    ],
)
def test_protocol_failures(tmp_path, export, body, kind):
    command = "detect" if "match" in body else "convert"
    target = target_of(write_connector(tmp_path / "c", code=_code(body)))
    result = execute(target, command, file=export, sandbox=NoSandbox())
    assert (result.outcome, result.error_kind) == ("failed", kind), result


def test_oversize_stdout_fails(tmp_path, export, monkeypatch):
    monkeypatch.setattr(proto, "MAX_STDOUT_BYTES", 1000)
    code = _code("sys.stdout.write('x' * 50000)\nsys.stdout.flush()\n")
    target = target_of(write_connector(tmp_path / "c", code=code))
    result = execute(target, "convert", file=export, sandbox=NoSandbox())
    assert (result.outcome, result.error_kind) == ("failed", "protocol")
    assert "stdout larger than" in result.message


def test_timeout_kills_the_process_group(tmp_path, export):
    marker = tmp_path / "child.pid"
    code = _code(
        "import subprocess, time\n"
        f"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(marker)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(60)\n"
    )
    target = target_of(write_connector(tmp_path / "c", code=code, timeout=1))
    started = time.monotonic()
    result = execute(target, "convert", file=export, sandbox=NoSandbox())
    assert (result.outcome, result.error_kind) == ("timeout", "timeout")
    assert time.monotonic() - started < 10
    pid = int(marker.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and _alive(pid):
        time.sleep(0.05)
    assert not _alive(pid), "the grandchild survived the timeout"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # a zombie (exited, waiting for its parent) counts as dead
    try:
        import subprocess

        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                               text=True, check=False).stdout.strip()
    except OSError:
        return True
    return bool(state) and not state.startswith("Z")


def test_detect_has_its_own_short_timeout(tmp_path, export, monkeypatch):
    from finanse.core.connectors import manifest as mf

    monkeypatch.setattr(mf, "DETECT_TIMEOUT_S", 1)
    target = target_of(write_connector(tmp_path / "c", code=_code("import time\ntime.sleep(30)\n")))
    result = execute(target, "detect", file=export, sandbox=NoSandbox())
    assert result.outcome == "timeout"


def test_refusals_before_running(tmp_path, export):
    target = target_of(write_connector(tmp_path / "c"))
    sandbox = NoSandbox()
    wrong_ext = InputFile(export.path, "statement.xlsx")
    assert execute(target, "convert", file=wrong_ext, sandbox=sandbox).error_kind == "bad_request"
    assert execute(target, "fetch", sandbox=sandbox).error_kind == "bad_request"
    assert execute(target, "convert", sandbox=sandbox).error_kind == "bad_request"
    assert sandbox.specs == []


def test_unsupported_sandbox_never_runs(tmp_path, export):
    from finanse.core.connectors.sandbox import SANDBOX_UNAVAILABLE_PL, UnsupportedSandbox

    target = target_of(write_connector(tmp_path / "c"))
    result = execute(target, "convert", file=export, sandbox=UnsupportedSandbox())
    assert (result.outcome, result.error_kind) == ("refused", "sandbox_unavailable")
    assert result.message == SANDBOX_UNAVAILABLE_PL


def test_argv_makes_connector_files_absolute(tmp_path):
    root = write_connector(tmp_path / "c")
    target = target_of(root)
    argv = target.argv()
    assert argv[1] == os.path.realpath(root / "main.py")


def test_profile_shape(tmp_path):
    """Deny by default, no mach-lookup, network only for fetch and only to the proxy port; paths are
    escaped real paths."""
    from finanse.core.connectors.sandbox import RunSpec, render_profile

    root = tmp_path / 'we"ird\\dir'
    root.mkdir()
    spec = RunSpec(
        argv=("/bin/echo",), connector_dir=root, interpreter=Path("/bin/echo"), run_dir=tmp_path,
        env={}, stdin=b"", timeout_s=1, max_stdout=10,
    )
    profile = render_profile(spec)
    code = "\n".join(line for line in profile.splitlines() if not line.lstrip().startswith(";"))
    assert "(deny default)" in code and "(allow default)" not in code
    assert "mach-lookup" not in code and "network" not in code
    assert '\\"ird\\\\dir' in code  # SBPL-escaped
    fetch = render_profile(dataclasses.replace(spec, proxy_port=4321))
    fetch_code = "\n".join(line for line in fetch.splitlines() if not line.lstrip().startswith(";"))
    assert '(allow network-outbound (remote tcp "localhost:4321"))' in fetch_code
    assert fetch_code.count("network") == 1
    for forbidden in ("SecurityServer", "securityd", "pasteboard", "windowserver"):
        assert forbidden not in fetch_code
    # BE-C3: /Library is not readable at all; the keychains are denied explicitly, after every allow
    assert '(subpath "/Library")' not in fetch_code
    deny = '(deny file-read* file-write*\n  (subpath "/Library/Keychains"))'
    assert deny in fetch_code and fetch_code.count("Keychains") == 1
    assert fetch_code.index(deny) > fetch_code.index("(allow file-read*\n  (subpath \"/usr\")")


# --------------------------------------------------------------------------- #
# Egress proxy
# --------------------------------------------------------------------------- #

HOSTS = ("api.example.com",)


@pytest.mark.parametrize(
    ("line", "allowed", "host", "status"),
    [
        ("CONNECT api.example.com:443 HTTP/1.1", True, "api.example.com", 200),
        ("CONNECT API.Example.COM:443 HTTP/1.1", True, "api.example.com", 200),
        ("CONNECT api.example.com.:443 HTTP/1.0", True, "api.example.com", 200),
        ("CONNECT api.example.com:80 HTTP/1.1", False, "api.example.com", 403),
        ("CONNECT api.example.com:8443 HTTP/1.1", False, "api.example.com", 403),
        ("CONNECT evil.example.com:443 HTTP/1.1", False, "evil.example.com", 403),
        ("CONNECT api.example.com.evil.net:443 HTTP/1.1", False, "api.example.com.evil.net", 403),
        ("CONNECT 127.0.0.1:443 HTTP/1.1", False, "127.0.0.1", 403),
        ("CONNECT [::1]:443 HTTP/1.1", False, None, 403),
        ("CONNECT api.example.com HTTP/1.1", False, "api.example.com", 403),
        ("GET http://api.example.com/x HTTP/1.1", False, "api.example.com", 403),
        ("GET / HTTP/1.1", False, None, 403),
        ("garbage", False, None, 400),
    ],
)
def test_proxy_decision(line, allowed, host, status):
    d = px.decide(line, HOSTS)
    assert (d.allowed, d.host, d.status) == (allowed, host, status)


def test_public_address_refuses_private_targets():
    def info(addr):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, 443))]

    assert px.public_address(info("93.184.216.34")) == "93.184.216.34"
    for addr in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.1.1", "0.0.0.0", "224.0.0.1"):
        assert px.public_address(info(addr)) is None, addr
    mixed = info("93.184.216.34") + info("127.0.0.1")
    assert px.public_address(mixed) is None


class _Upstream:
    """A local TLS-less echo server standing in for an allowed API host."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            data = conn.recv(1024)
            conn.sendall(b"echo:" + data)
            conn.close()

    def close(self):
        self.sock.close()


def _tunnel(port: int, target: str, payload: bytes) -> tuple[bytes, bytes]:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1024)
            if not chunk:
                break
            head += chunk
        if not head.startswith(b"HTTP/1.1 200"):
            return head, b""
        s.sendall(payload)
        body = b""
        while chunk := s.recv(1024):
            body += chunk
        return head, body


def test_proxy_tunnels_allowed_hosts_and_records_denials():
    upstream = _Upstream()

    async def connect(host, port):
        assert (host, port) == ("api.example.com", 443)
        return await asyncio.open_connection("127.0.0.1", upstream.port)

    try:
        with px.EgressProxy(HOSTS, connect=connect) as proxy:
            head, body = _tunnel(proxy.port, "api.example.com:443", b"hello")
            assert head.startswith(b"HTTP/1.1 200") and body == b"echo:hello"
            denied, _ = _tunnel(proxy.port, "other.example.org:443", b"x")
            assert denied.startswith(b"HTTP/1.1 403")
            denied, _ = _tunnel(proxy.port, "api.example.com:80", b"x")
            assert denied.startswith(b"HTTP/1.1 403")
            time.sleep(0.1)
            assert proxy.denied_hosts == ["other.example.org", "api.example.com"]
            assert (proxy.bytes_up, proxy.bytes_down) == (5, 10)
    finally:
        upstream.close()


def test_proxy_default_connect_refuses_loopback(monkeypatch):
    """Without a test connector, a host resolving to the machine itself is never tunnelled."""

    async def fake_getaddrinfo(self, host, port, **kw):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    monkeypatch.setattr(asyncio.BaseEventLoop, "getaddrinfo", fake_getaddrinfo)
    with px.EgressProxy(HOSTS) as proxy:
        head, _ = _tunnel(proxy.port, "api.example.com:443", b"x")
    assert head.startswith(b"HTTP/1.1 502")


def test_inputs_never_raise_through(tmp_path, export):
    """A sandbox that raises is recorded as a failed run, not an exception."""

    class Boom:
        name = "boom"

        def run(self, spec):
            raise RuntimeError("boom")

    target = target_of(write_connector(tmp_path / "c"))
    result = execute(target, "convert", file=export, sandbox=Boom())
    assert (result.outcome, result.error_kind) == ("failed", "spawn_failed")
    assert list(Path(runner.runs_dir()).iterdir()) == []


def test_document_numbers_are_exact(tmp_path, export):
    """BE-6: a document's JSON numbers are Decimals (never binary floats) and go back to the importers
    as the same JSON numbers; big integers stay exact."""
    from decimal import Decimal

    raw = ('{"document": {"q": 0.123456789012345678, "big": 12345678901234567.89, '
           '"exp": 1e400, "n": 123456789012345678901234567890, "neg": -0.0, "s": "z\\u0142"}}')
    code = _code(f"print({raw!r})\n")
    target = target_of(write_connector(tmp_path / "c", code=code))
    result = execute(target, "convert", file=export, sandbox=NoSandbox())
    assert result.ok, result
    doc = result.response.document
    assert doc["q"] == Decimal("0.123456789012345678") and isinstance(doc["q"], Decimal)
    assert doc["big"] == Decimal("12345678901234567.89")
    assert doc["n"] == 123456789012345678901234567890
    out = proto.document_bytes(doc).decode("utf-8")
    assert out == ('{"q":0.123456789012345678,"big":12345678901234567.89,"exp":1E+400,'
                   '"n":123456789012345678901234567890,"neg":-0.0,"s":"z\u0142"}')
    assert json.loads(out, parse_float=Decimal)["q"] == Decimal("0.123456789012345678")
