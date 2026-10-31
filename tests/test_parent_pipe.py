"""`cashu serve --parent-pipe`: the token comes from the parent over stdin, nothing prints or stores
it, and the server stops when the parent goes away (core/parent_pipe.py)."""

from __future__ import annotations

import io
import os
import signal
import socket
import subprocess
import sys
import threading
import time

import httpx
import pytest
from typer.testing import CliRunner

from cashu import db
from cashu.core import parent_pipe, paths, security

TOKEN = "parentToken_0123456789abcdefghijklmnopqrstu"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv(security.TOKEN_ENV, raising=False)
    monkeypatch.setattr(security, "_config", None)
    engine = db.make_engine(f"sqlite:///{tmp_path / 'api.db'}")
    monkeypatch.setattr(db, "engine", engine)
    yield
    engine.dispose()


# --------------------------------------------------------------------------- #
# The pipe contract
# --------------------------------------------------------------------------- #


def test_reads_the_token_from_the_first_line():
    stream = io.BytesIO(f"{TOKEN}\nrest".encode())
    assert parent_pipe.read_token(stream) == TOKEN
    assert stream.read() == b"rest"  # the watcher gets everything after the token line


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "closed before"),
        (TOKEN.encode(), "first line"),  # no newline: the parent died mid-write
        (b"short\n", "32-256"),
        (b"has space in it 0123456789abcdefghijklmnop\n", "32-256"),
        (b"x" * 600 + b"\n", "first line"),
    ],
)
def test_refuses_a_missing_or_malformed_token(data, message):
    with pytest.raises(parent_pipe.ParentPipeError, match=message):
        parent_pipe.read_token(io.BytesIO(data))


def test_watch_fires_once_when_the_parent_end_closes():
    read_fd, write_fd = os.pipe()
    fired = threading.Event()
    calls: list[int] = []

    def gone() -> None:
        calls.append(1)
        fired.set()

    with os.fdopen(read_fd, "rb") as reader:
        thread = parent_pipe.watch(reader, gone)
        os.write(write_fd, b"ignored chatter\n")
        time.sleep(0.1)
        assert not fired.is_set()  # data is not end of file
        os.close(write_fd)
        assert fired.wait(5)
        thread.join(5)
    assert calls == [1]


def test_stop_process_terminates_gracefully_then_hard():
    killed: list[tuple[int, int]] = []
    exited = threading.Event()
    codes: list[int] = []

    def hard_exit(code: int) -> None:
        codes.append(code)
        exited.set()

    parent_pipe.stop_process(0.05, kill=lambda pid, sig: killed.append((pid, sig)), hard_exit=hard_exit)
    assert killed == [(os.getpid(), signal.SIGTERM)]
    assert exited.wait(5)
    assert codes == [1]


# --------------------------------------------------------------------------- #
# `cashu serve --parent-pipe` (uvicorn faked)
# --------------------------------------------------------------------------- #


@pytest.fixture
def fake_serve(monkeypatch):
    import uvicorn

    calls: list[dict] = []
    stops: list[int] = []

    def fake_run(app_path, **kwargs):
        cfg = security.get_config()
        calls.append({**kwargs, "token": cfg.token, "token_file": paths.token_path().exists()})

    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr(parent_pipe, "stop_process", lambda: stops.append(1))
    return calls, stops


def test_serve_takes_the_token_from_the_parent_and_never_shows_it(fake_serve):
    from cashu.cli import app

    calls, stops = fake_serve
    result = CliRunner().invoke(app, ["serve", "--parent-pipe", "--port", "8644"], input=f"{TOKEN}\n")
    assert result.exit_code == 0, result.output
    (call,) = calls
    assert call["token"] == TOKEN and call["port"] == 8644 and call["reload"] is False
    assert call["token_file"] is False  # no <data dir>/api-token in this mode
    assert TOKEN not in result.output
    assert "#token=" not in result.output
    assert "http://127.0.0.1:8644/" in result.output
    for _ in range(50):  # CliRunner's stdin ends right after the token: the watcher saw EOF
        if stops:
            break
        time.sleep(0.02)
    assert stops == [1]


def test_serve_without_the_option_is_unchanged(fake_serve):
    from cashu.cli import app

    calls, stops = fake_serve
    result = CliRunner().invoke(app, ["serve", "--port", "8645"], input=f"{TOKEN}\n")
    assert result.exit_code == 0, result.output
    (call,) = calls
    assert call["token"] != TOKEN  # stdin is not read
    assert call["token_file"] is True
    assert f"#token={call['token']}" in "".join(result.stdout.split())
    assert stops == []


@pytest.mark.parametrize(
    ("args", "data"),
    [(["--reload"], f"{TOKEN}\n"), ([], "short\n"), ([], "")],
)
def test_serve_refuses_a_bad_parent_pipe(fake_serve, args, data):
    from cashu.cli import app

    calls, _ = fake_serve
    result = CliRunner().invoke(app, ["serve", "--parent-pipe", *args], input=data)
    assert result.exit_code == 2, result.output
    assert calls == []


# --------------------------------------------------------------------------- #
# The real server: a SIGKILLed parent leaves no orphan behind
# --------------------------------------------------------------------------- #

PARENT_STAND_IN = """
import subprocess, sys, time
log = open(sys.argv[1], "wb")
child = subprocess.Popen(sys.argv[2:], stdin=subprocess.PIPE, stdout=log, stderr=log)
child.stdin.write(sys.stdin.buffer.readline())
child.stdin.flush()
print(child.pid, flush=True)
time.sleep(600)
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL")
def test_the_server_exits_when_its_parent_is_killed(tmp_path):
    data_dir = tmp_path / "pipe-data"
    port = _free_port()
    env = {**os.environ, "CASHU_DATA_DIR": str(data_dir), "CASHU_AUTO_DAILY": "0"}
    serve = [sys.executable, "-c", "from cashu.cli import app; app()", "serve", "--parent-pipe",
             "--port", str(port)]
    parent = subprocess.Popen(
        [sys.executable, "-c", PARENT_STAND_IN, str(tmp_path / "serve.log"), *serve],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
    )
    child_pid = 0
    try:
        parent.stdin.write(f"{TOKEN}\n".encode())
        parent.stdin.close()
        child_pid = int(parent.stdout.readline())
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 60
        status = None
        while time.monotonic() < deadline:
            try:
                status = httpx.get(f"{base}/api/health", headers={security.TOKEN_HEADER: TOKEN}).status_code
                break
            except httpx.TransportError:
                assert _alive(child_pid), (tmp_path / "serve.log").read_text()
                time.sleep(0.2)
        assert status == 200, (tmp_path / "serve.log").read_text()
        assert httpx.get(f"{base}/api/health").status_code == 401
        assert not (data_dir / paths.TOKEN_FILENAME).exists()  # nothing stores the token
        assert TOKEN not in (tmp_path / "serve.log").read_text()

        parent.kill()  # SIGKILL: no handler, no cleanup in the parent
        parent.wait(10)
        deadline = time.monotonic() + parent_pipe.STOP_GRACE + 5
        while _alive(child_pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not _alive(child_pid), "the server outlived its SIGKILLed parent"
        with pytest.raises(httpx.TransportError):
            httpx.get(f"{base}/api/health", headers={security.TOKEN_HEADER: TOKEN}, timeout=1)
    finally:
        if parent.poll() is None:
            parent.kill()
        if child_pid and _alive(child_pid):
            os.kill(child_pid, signal.SIGKILL)
