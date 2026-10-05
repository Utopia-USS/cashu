"""``finanse app``: the dashboard in a native window (pywebview) over an in-process server.

- One instance per data dir: ``core.locks.run_lock("desktop")``. A second launch brings the running
  window to the front (macOS) and exits with a message. (Finder never starts a second copy of the
  same ``.app`` anyway; this covers the CLI and ``open -n``.)
- The server is uvicorn in a background thread of this process, bound to 127.0.0.1 only, with a
  fresh per-launch token (``core.security``: Host check + token on every ``/api/*`` call; the page
  gets the token from the meta tag). The port is a random free port, remembered in
  ``<data dir>/desktop.json`` and reused while it is free, so the window's origin (and the
  WebView's localStorage: chosen profile, theme, layout) stays the same between launches.
  The socket is bound before uvicorn starts, so no other process can take the port in between.
- Unlike ``finanse serve`` the app does not write ``<data dir>/api-token`` (the window does not need
  it, and a ``finanse serve`` running next to the app keeps its own file).
- Closing the window (or Cmd+Q) stops the server and ends the process.
- Log: ``<data dir>/logs/app.log`` (warnings and errors; no request log).
"""

from __future__ import annotations

import html
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..core import locks, paths, security
from . import DEBUG_ENV

log = logging.getLogger("finanse.desktop")

TITLE = "finanse"
LOCK_NAME = "desktop"
STATE_FILE = "desktop.json"
LOG_FILE = "app.log"
# The investments workspace is laid out for 1440 px (+ 2 x 20 px page padding); the CSS falls back
# to two columns below 1240 px and keeps working down to phone widths, so the window may shrink to
# the smallest common laptop working area.
DEFAULT_SIZE = (1480, 940)
MIN_SIZE = (1024, 680)
SCREEN_MARGIN = 80
STARTUP_TIMEOUT = 60.0
STOP_TIMEOUT = 10.0


class DesktopError(RuntimeError):
    """The desktop window cannot be opened (message safe to show)."""


class AlreadyRunning(DesktopError):
    """Another ``finanse app`` holds the lock for this data dir."""

    def __init__(self, pid: int | None, focused: bool) -> None:
        who = f" (pid {pid})" if pid else ""
        tail = "; its window was brought to the front." if focused else "."
        super().__init__(f"finanse is already open{who}{tail}")
        self.pid = pid
        self.focused = focused


# --------------------------------------------------------------------------- #
# State (remembered port) and logging
# --------------------------------------------------------------------------- #


def state_path() -> Path:
    return paths.data_dir() / STATE_FILE


def load_state(path: Path | None = None) -> dict:
    try:
        data = json.loads((path or state_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: dict, path: Path | None = None) -> None:
    path = path or state_path()
    paths.ensure_private_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def remembered_port(state: dict) -> int | None:
    port = state.get("port")
    return port if isinstance(port, int) and 1024 <= port <= 65535 else None


def log_path() -> Path:
    return paths.logs_dir() / LOG_FILE


def setup_logging(*, requests: bool = False) -> Path:
    """Warnings and errors of the app (and uvicorn) to ``<data dir>/logs/app.log`` (0600);
    ``requests`` adds the request log (method, path, status), for debugging only."""
    path = log_path()
    paths.ensure_private_dir(paths.data_dir())  # first launch: the data dir itself 0700, too
    paths.ensure_private_dir(path.parent)
    if not path.exists():
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600))
    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=1_000_000, backupCount=2, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    log.setLevel(logging.INFO)
    if requests:
        logging.getLogger("uvicorn.access").setLevel(logging.INFO)
    return path


# --------------------------------------------------------------------------- #
# Server
# --------------------------------------------------------------------------- #


def bind_loopback(preferred: int | None = None) -> socket.socket:
    """A TCP socket bound to 127.0.0.1: on ``preferred`` when it is free, else on a random port."""
    for port in ([preferred] if preferred else []) + [0]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            sock.close()
            continue
        sock.set_inheritable(False)
        return sock
    raise DesktopError("No free port on 127.0.0.1")  # pragma: no cover - port 0 always binds


class ServerThread:
    """uvicorn serving ``finanse.api.app`` on an already bound socket, in a daemon thread."""

    def __init__(
        self,
        sock: socket.socket,
        app: object | str = "finanse.api.app:app",
        *,
        access_log: bool = False,
    ) -> None:
        import uvicorn

        self.sock = sock
        self.port: int = sock.getsockname()[1]
        config = uvicorn.Config(
            app,
            # uvicorn sets its access logger to log_level: "info" lets the request log through.
            log_level="info" if access_log else "warning",
            access_log=access_log,
            lifespan="on",
            log_config=None,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self._run, name="finanse-server", daemon=True)
        self.error: BaseException | None = None

    def _run(self) -> None:
        try:
            self.server.run(sockets=[self.sock])
        except BaseException as e:
            self.error = e
            log.exception("server stopped with an error")

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def start(self, timeout: float = STARTUP_TIMEOUT) -> None:
        self.thread.start()
        deadline = time.monotonic() + timeout
        while not self.server.started:
            if not self.thread.is_alive():
                raise DesktopError(
                    "The local server did not start" + (f": {self.error}" if self.error else "")
                )
            if time.monotonic() >= deadline:
                raise DesktopError(f"The local server did not start within {int(timeout)} s")
            time.sleep(0.05)

    def stop(self, timeout: float = STOP_TIMEOUT) -> None:
        self.server.should_exit = True
        if self.thread.is_alive():
            self.thread.join(timeout)
        try:
            self.sock.close()
        except OSError:  # pragma: no cover
            pass


# --------------------------------------------------------------------------- #
# Single instance
# --------------------------------------------------------------------------- #


def running_pid() -> int | None:
    """PID written by the instance holding the desktop lock (best effort)."""
    try:
        return int(locks.lock_path(LOCK_NAME).read_text().strip())
    except (OSError, ValueError):
        return None


def focus_process(pid: int) -> bool:
    """Bring the app with ``pid`` to the front (macOS, via AppKit); False when not possible."""
    if sys.platform != "darwin":
        return False
    try:
        from AppKit import NSApplicationActivateIgnoringOtherApps, NSRunningApplication
    except ImportError:
        return False
    app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if app is None:
        return False
    return bool(app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps))


# --------------------------------------------------------------------------- #
# Window
# --------------------------------------------------------------------------- #

_PAGE = """<!doctype html><html lang="pl"><head><meta charset="utf-8"><style>
:root {{ color-scheme: light dark; }}
body {{ font: 14px -apple-system, system-ui, sans-serif; display: flex; align-items: center;
  justify-content: center; height: 100vh; margin: 0; background: #fff; color: #222; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #141414; color: #ddd; }} }}
main {{ max-width: 560px; padding: 24px; }} code {{ font-size: 12px; }}
</style></head><body><main>{body}</main></body></html>"""

LOADING_HTML = _PAGE.format(body="<p>Uruchamianie finanse…</p>")


def error_html(message: str, log_file: Path | None) -> str:
    where = (
        f"<p>Szczegóły w logu: <code>{html.escape(str(log_file))}</code></p>" if log_file else ""
    )
    return _PAGE.format(
        body=f"<h2>Nie udało się uruchomić finanse</h2><p>{html.escape(message)}</p>{where}"
    )


def window_size(screens: list | None) -> tuple[int, int]:
    """The default size, shrunk to the main screen (never below the minimum size)."""
    width, height = DEFAULT_SIZE
    if screens:
        screen = screens[0]
        width = min(width, int(screen.width) - SCREEN_MARGIN)
        height = min(height, int(screen.height) - SCREEN_MARGIN)
    return max(width, MIN_SIZE[0]), max(height, MIN_SIZE[1])


@dataclass
class Launch:
    """What one ``run()`` did (returned for tests and the CLI)."""

    port: int | None = None
    error: str | None = None


def _import_webview():
    try:
        import webview
    except ImportError as e:
        raise DesktopError('The desktop window needs pywebview: pip install -e ".[desktop]"') from e
    return webview


def _boot(window, server: ServerThread, launch: Launch, log_file: Path | None) -> None:
    """Runs in pywebview's worker thread once the window exists: start the server, show the app."""
    try:
        server.start()
    except DesktopError as e:
        launch.error = str(e)
        log.error("%s", e)
        window.load_html(error_html(str(e), log_file))
        return
    state = load_state()
    if state.get("port") != server.port:
        state["port"] = server.port
        save_state(state)
    window.load_url(server.url)


def run(*, debug: bool = False, webview_module=None, log_file: Path | None = None) -> Launch:
    """Open the window and block until it is closed. Raises :class:`AlreadyRunning` when another
    instance holds the lock (after trying to bring it to the front), :class:`DesktopError` when
    pywebview is missing."""
    webview = webview_module or _import_webview()
    debug = debug or os.environ.get(DEBUG_ENV) == "1"
    launch = Launch()
    # mkdir -p would create a missing data dir with the default mode; it must be 0700.
    paths.ensure_private_dir(paths.data_dir())
    try:
        with locks.run_lock(LOCK_NAME):
            sock = bind_loopback(remembered_port(load_state()))
            cfg = security.configure(port=sock.getsockname()[1])
            server = ServerThread(sock, access_log=debug)
            launch.port = cfg.port
            log.info("desktop server on 127.0.0.1:%s", cfg.port)
            webview.settings["ALLOW_DOWNLOADS"] = True
            webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
            webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False  # inspector via right click only
            try:
                screens = list(webview.screens)
            except Exception:  # noqa: BLE001 - no screen info: default size
                screens = []
            width, height = window_size(screens)
            window = webview.create_window(
                TITLE,
                html=LOADING_HTML,
                width=width,
                height=height,
                min_size=MIN_SIZE,
                text_select=True,
                zoomable=True,
            )
            try:
                webview.start(
                    _boot,
                    (window, server, launch, log_file),
                    debug=debug,
                    private_mode=False,
                    storage_path=str(paths.ensure_private_dir(paths.data_dir() / "webview")),
                )
            finally:
                server.stop()
    except locks.LockBusy:
        pid = running_pid()
        raise AlreadyRunning(pid, pid is not None and focus_process(pid)) from None
    return launch
