"""Desktop shell and packaged-app awareness (``finanse app``, ``core/runtime.py``, the frozen
entry point). No real window, no real data dir: pywebview is replaced by a fake module and the
server thread serves a tiny ASGI app behind the real security middleware."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from typer.testing import CliRunner

from finanse.core import locks, runtime, security
from finanse.desktop import entry, shell

APP_EXE = "/Applications/Finanse.app/Contents/MacOS/finanse"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("FINANSE_DATA_DIR", str(path))
    # shell.run() configures the process-wide security config; restore it afterwards.
    monkeypatch.setattr(security, "_config", security._config)
    return path


@pytest.fixture
def frozen(monkeypatch, tmp_path):
    """Pretend to run inside Finanse.app (PyInstaller)."""
    meipass = tmp_path / "bundle"
    meipass.mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", APP_EXE)
    monkeypatch.setattr(sys, "_MEIPASS", str(meipass), raising=False)
    return meipass


# --------------------------------------------------------------------------- #
# core/runtime.py
# --------------------------------------------------------------------------- #


def test_runtime_from_source_keeps_the_plain_command():
    assert not runtime.frozen()
    assert runtime.executable() is None and runtime.app_bundle() is None
    assert runtime.cli_program() == ["finanse"]
    assert runtime.mcp_command("jan") == "finanse mcp --profile jan"
    assert (
        runtime.claude_mcp_add("jan") == "claude mcp add finanse-jan -- finanse mcp --profile jan"
    )
    assert runtime.claude_desktop_config("jan") == {
        "mcpServers": {"finanse-jan": {"command": "finanse", "args": ["mcp", "--profile", "jan"]}}
    }
    assert runtime.skills_dir() == runtime.paths.PROJECT_ROOT / ".claude" / "skills"


def test_runtime_frozen_points_at_the_bundled_binary(frozen):
    assert runtime.frozen()
    assert runtime.app_bundle() == Path("/Applications/Finanse.app")
    assert runtime.cli_program() == [APP_EXE]
    assert runtime.mcp_command("jan") == f"{APP_EXE} mcp --profile jan"
    assert (
        runtime.claude_mcp_add("jan")
        == f"claude mcp add finanse-jan -- {APP_EXE} mcp --profile jan"
    )
    entry_ = runtime.claude_desktop_config("jan")["mcpServers"]["finanse-jan"]
    assert entry_ == {"command": APP_EXE, "args": ["mcp", "--profile", "jan"]}
    assert not runtime.translocated()
    assert runtime.skills_dir() is None  # not bundled in this fake bundle
    (frozen / "skills").mkdir()
    assert runtime.skills_dir() == frozen / "skills"


def test_runtime_quotes_a_path_with_spaces(frozen, monkeypatch):
    exe = "/Users/x/My Apps/Finanse.app/Contents/MacOS/finanse"
    monkeypatch.setattr(sys, "executable", exe)
    assert (
        runtime.claude_mcp_add("jan") == f"claude mcp add finanse-jan -- '{exe}' mcp --profile jan"
    )
    assert runtime.claude_desktop_config("jan")["mcpServers"]["finanse-jan"]["command"] == exe


def test_worker_entry_point_uses_the_bundle_and_refuses_translocation(frozen, monkeypatch):
    from finanse.core.worker import scheduler

    monkeypatch.setattr("finanse.config.settings.worker_program", None)
    assert scheduler.entry_point() == [APP_EXE]
    moved = "/private/var/folders/x/T/AppTranslocation/ABC/d/Finanse.app/Contents/MacOS/finanse"
    monkeypatch.setattr(sys, "executable", moved)
    assert runtime.translocated()
    with pytest.raises(scheduler.WorkerSchedulerError, match="Applications"):
        scheduler.entry_point()
    # An explicit program still wins (FINANSE_WORKER_PROGRAM / --program).
    assert scheduler.entry_point("/opt/finanse") == ["/opt/finanse"]


def test_mcp_endpoints_use_the_bundled_binary_when_packaged(api_empty, frozen):
    created = api_empty.post(
        "/api/profiles",
        json={
            "name": "Test",
            "base_currency": "PLN",
            "modules": ["investments"],
            "mcp_privacy": "strict",
        },
    )
    assert created.status_code in (200, 201), created.text
    slug = created.json()["slug"]
    info = api_empty.get(f"/api/p/{slug}/mcp").json()
    assert info["packaged"] is True
    assert info["command"] == f"{APP_EXE} mcp --profile {slug}"
    assert (
        info["claude_mcp_add"] == f"claude mcp add finanse-{slug} -- {APP_EXE} mcp --profile {slug}"
    )
    assert info["claude_desktop"] == {"command": APP_EXE, "args": ["mcp", "--profile", slug]}
    setup = api_empty.get(f"/api/p/{slug}/modules/investments/setup").json()
    assert setup["skill"]["mcp_add"] == info["claude_mcp_add"]


# --------------------------------------------------------------------------- #
# Frozen entry point
# --------------------------------------------------------------------------- #


def test_entry_without_arguments_opens_the_app(monkeypatch):
    calls = []
    monkeypatch.setattr("finanse.cli.app", lambda **kw: calls.append(kw))
    entry.main([])
    entry.main(["-psn_0_12345"])  # Finder on old macOS versions
    entry.main(["worker", "run", "--offline"])
    assert [c["args"] for c in calls] == [["app"], ["app"], ["worker", "run", "--offline"]]
    assert all(c["prog_name"] == "finanse" for c in calls)


def test_entry_runs_a_converter_script_like_python_dash_i(tmp_path, monkeypatch):
    script = tmp_path / "converter.py"
    script.write_text(
        "import sys, pathlib\n"
        "pathlib.Path(sys.argv[2]).write_text(pathlib.Path(sys.argv[1]).read_text().upper())\n"
        "sys.exit(0 if __name__ == '__main__' else 5)\n"
    )
    (tmp_path / "in.csv").write_text("a;b\n")
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    with pytest.raises(SystemExit) as done:
        entry.main(["-I", str(script), str(tmp_path / "in.csv"), str(tmp_path / "out.csv")])
    assert done.value.code == 0
    assert (tmp_path / "out.csv").read_text() == "A;B\n"
    assert entry.is_script_call(["-I", "x.py"]) and not entry.is_script_call(["-I"])


# --------------------------------------------------------------------------- #
# Shell pieces
# --------------------------------------------------------------------------- #


def test_bind_loopback_reuses_a_free_port_and_falls_back_when_taken():
    first = shell.bind_loopback()
    port = first.getsockname()[1]
    assert first.getsockname()[0] == "127.0.0.1"
    first.listen()
    other = shell.bind_loopback(port)  # taken by `first`
    assert other.getsockname()[1] != port
    first.close()
    other.close()
    again = shell.bind_loopback(port)
    assert again.getsockname()[1] == port
    again.close()


def test_state_file_is_private(data_dir):
    shell.save_state({"port": 50123})
    path = shell.state_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert shell.remembered_port(shell.load_state()) == 50123
    assert shell.remembered_port({"port": "x"}) is None
    assert shell.remembered_port({"port": 80}) is None
    path.write_text("{broken")
    assert shell.load_state() == {}


def test_window_size_fits_the_screen():
    assert shell.window_size([]) == shell.DEFAULT_SIZE
    small = SimpleNamespace(width=1280, height=800)
    assert shell.window_size([small]) == (1200, 720)
    tiny = SimpleNamespace(width=800, height=600)
    assert shell.window_size([tiny]) == shell.MIN_SIZE


def test_error_page_escapes_the_message(tmp_path):
    page = shell.error_html("<script>x</script>", tmp_path / "app.log")
    assert "<script>x</script>" not in page and "&lt;script&gt;" in page
    assert "app.log" in page


async def _hello(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send({"type": "http.response.body", "body": b"ok"})


def _secured_app():
    return security.LocalOnlyMiddleware(_hello)


def test_server_thread_serves_with_the_token_and_stops(data_dir):
    sock = shell.bind_loopback()
    cfg = security.configure(port=sock.getsockname()[1])
    server = shell.ServerThread(sock, _secured_app())
    server.start(timeout=10)
    try:
        assert httpx.get(f"{server.url}api/x").status_code == 401
        ok = httpx.get(f"{server.url}api/x", headers={security.TOKEN_HEADER: cfg.token})
        assert ok.status_code == 200 and ok.text == "ok"
        foreign = httpx.get(
            f"{server.url}api/x",
            headers={security.TOKEN_HEADER: cfg.token, "Host": f"evil.example:{cfg.port}"},
        )
        assert foreign.status_code == 400
    finally:
        server.stop()
    assert not server.thread.is_alive()
    with pytest.raises(httpx.ConnectError):
        httpx.get(server.url, timeout=1)


def test_debug_server_thread_logs_requests(data_dir, caplog):
    sock = shell.bind_loopback()
    cfg = security.configure(port=sock.getsockname()[1])
    server = shell.ServerThread(sock, _secured_app(), access_log=True)
    server.start(timeout=10)
    try:
        with caplog.at_level("INFO", logger="uvicorn.access"):
            httpx.get(f"{server.url}api/x", headers={security.TOKEN_HEADER: cfg.token})
            httpx.get(f"{server.url}api/x")
    finally:
        server.stop()
    lines = [r.getMessage() for r in caplog.records if r.name == "uvicorn.access"]
    assert any("/api/x" in line and "200" in line for line in lines)
    assert any("401" in line for line in lines)
    assert not any(cfg.token in line for line in lines)  # the header never reaches the log


class FakeWindow:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.loaded: list[tuple[str, str]] = []

    def load_url(self, url):
        self.loaded.append(("url", url))

    def load_html(self, page):
        self.loaded.append(("html", page))


class FakeWebview:
    """Stands in for pywebview: start() runs the boot function, checks the server like the
    window would, then returns as if the user closed the window."""

    def __init__(self, check=None):
        self.settings: dict = {}
        self.screens = [SimpleNamespace(width=1512, height=982)]
        self.window: FakeWindow | None = None
        self.start_kwargs: dict = {}
        self.check = check

    def create_window(self, title, **kwargs):
        self.window = FakeWindow(title=title, **kwargs)
        return self.window

    def start(self, func, args, **kwargs):
        self.start_kwargs = kwargs
        func(*args)
        if self.check:
            self.check(self)


def _patch_server_app(monkeypatch):
    real = shell.ServerThread

    def factory(sock, app=None, **kw):
        return real(sock, _secured_app(), **kw)

    monkeypatch.setattr(shell, "ServerThread", factory)


def test_run_opens_the_window_on_the_server_and_stops_it(data_dir, monkeypatch):
    _patch_server_app(monkeypatch)
    seen = {}

    def check(fake):
        kind, url = fake.window.loaded[-1]
        assert kind == "url"
        seen["url"] = url
        token = security.get_config().token
        seen["status"] = httpx.get(
            f"{url}api/x", headers={security.TOKEN_HEADER: token}
        ).status_code
        seen["lock_pid"] = shell.running_pid()

    fake = FakeWebview(check)
    assert not data_dir.exists()
    launch = shell.run(webview_module=fake)
    assert stat.S_IMODE(data_dir.stat().st_mode) == 0o700  # first launch creates it private
    assert launch.error is None and launch.port
    assert seen == {
        "url": f"http://127.0.0.1:{launch.port}/",
        "status": 200,
        "lock_pid": os.getpid(),
    }
    w = fake.window.kwargs
    assert w["title"] == "finanse" and w["min_size"] == shell.MIN_SIZE
    assert (w["width"], w["height"]) == (1432, 902)  # 1512 x 982 screen minus the margin
    assert w["html"] == shell.LOADING_HTML and w["text_select"] is True
    assert fake.start_kwargs["private_mode"] is False and fake.start_kwargs["debug"] is False
    assert fake.settings["ALLOW_DOWNLOADS"] is True
    # The port is remembered for the next launch; nothing else is written to the data dir.
    assert shell.load_state() == {"port": launch.port}
    assert not (data_dir / "api-token").exists()
    # The server is gone once the window closed.
    with pytest.raises(httpx.ConnectError):
        httpx.get(f"http://127.0.0.1:{launch.port}/", timeout=1)
    # Next launch: same port (same WebView origin, so localStorage survives).
    assert shell.run(webview_module=FakeWebview()).port == launch.port


def test_run_shows_an_error_page_when_the_server_fails(data_dir, monkeypatch):
    class Broken:
        def __init__(self, sock, app=None, **kw):
            self.port = sock.getsockname()[1]
            sock.close()

        def start(self):
            raise shell.DesktopError("The local server did not start: boom")

        def stop(self):
            pass

    monkeypatch.setattr(shell, "ServerThread", Broken)
    fake = FakeWebview()
    launch = shell.run(webview_module=fake, log_file=data_dir / "logs" / "app.log")
    assert launch.error == "The local server did not start: boom"
    kind, page = fake.window.loaded[-1]
    assert kind == "html" and "boom" in page and "app.log" in page


def test_second_instance_is_refused_and_focuses_the_first(data_dir, monkeypatch):
    focused = []
    monkeypatch.setattr(shell, "focus_process", lambda pid: focused.append(pid) or True)
    with locks.run_lock(shell.LOCK_NAME), pytest.raises(shell.AlreadyRunning) as busy:
        shell.run(webview_module=FakeWebview())
    assert busy.value.pid == os.getpid() and busy.value.focused
    assert focused == [os.getpid()]
    assert "already open" in str(busy.value)


def test_missing_pywebview_is_explained(monkeypatch):
    monkeypatch.setitem(sys.modules, "webview", None)
    with pytest.raises(shell.DesktopError, match=r"\.\[desktop\]"):
        shell._import_webview()


# --------------------------------------------------------------------------- #
# CLI: finanse app, finanse skills
# --------------------------------------------------------------------------- #


def _cli():
    from finanse.cli import app

    return app


def test_app_command_exit_codes(data_dir, monkeypatch):
    runner = CliRunner()

    def busy(**kw):
        raise shell.AlreadyRunning(4242, focused=True)

    monkeypatch.setattr(shell, "run", busy)
    result = runner.invoke(_cli(), ["app"])
    assert result.exit_code == 0 and "already open (pid 4242)" in result.output

    monkeypatch.setattr(shell, "run", lambda **kw: shell.Launch(port=1, error="boom"))
    result = runner.invoke(_cli(), ["app"])
    assert result.exit_code == 1 and "boom" in result.output

    seen = {}
    monkeypatch.setattr(shell, "run", lambda **kw: seen.update(kw) or shell.Launch(port=1))
    monkeypatch.setenv("FINANSE_APP_DEBUG", "1")
    assert runner.invoke(_cli(), ["app"]).exit_code == 0
    assert seen["debug"] is True
    assert (data_dir / "logs" / "app.log").exists()
    assert stat.S_IMODE(data_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((data_dir / "logs" / "app.log").stat().st_mode) == 0o600


def test_skills_install_copies_and_respects_local_changes(tmp_path):
    runner = CliRunner()
    source = runtime.skills_dir()
    assert source is not None
    names = sorted(p.name for p in source.iterdir() if (p / "SKILL.md").is_file())
    assert "investments-setup" in names
    dest = tmp_path / "skills"
    first = runner.invoke(_cli(), ["skills", "install", "--dest", str(dest)])
    assert first.exit_code == 0, first.output
    assert sorted(p.name for p in dest.iterdir()) == names
    assert runner.invoke(_cli(), ["skills", "install", "--dest", str(dest)]).output.count(
        "up to date"
    ) == len(names)
    edited = dest / "investments-setup" / "SKILL.md"
    edited.write_text("my own version")
    kept = runner.invoke(_cli(), ["skills", "install", "--dest", str(dest)])
    assert kept.exit_code == 1 and edited.read_text() == "my own version"
    forced = runner.invoke(_cli(), ["skills", "install", "--dest", str(dest), "--force"])
    assert forced.exit_code == 0
    assert edited.read_text() == (source / "investments-setup" / "SKILL.md").read_text()
    shown = runner.invoke(_cli(), ["skills", "path"])
    assert shown.exit_code == 0 and shown.output.strip() == str(source)
