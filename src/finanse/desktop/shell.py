"""``finanse app``: the dashboard in a native window (pywebview) over an in-process server.

- One instance per data dir: ``core.locks.run_lock("desktop")``. A second launch brings the running
  window to the front (macOS) and exits with a message. (Finder never starts a second copy of the
  same ``.app`` anyway; this covers the CLI and ``open -n``.)
- The server is uvicorn in a background thread of this process, bound to 127.0.0.1 only, with a
  fresh per-launch token (``core.security``: Host check + token on every ``/api/*`` call). The
  served page never carries the token (any local process can ``GET /``): the window's page asks
  for it through the pywebview bridge, ``window.pywebview.api.token()`` (:func:`token_bridge`),
  which answers only while the window shows the app's own origin. The port is a random free port,
  remembered in ``<data dir>/desktop.json`` and reused while it is free, so the window's origin
  stays the same between launches. The socket is bound before uvicorn starts, so no other process
  can take the port in between.
- Unlike ``finanse serve`` the app does not write ``<data dir>/api-token`` (the window does not need
  it, and a ``finanse serve`` running next to the app keeps its own file).
- The window shows only the app's own origin (:func:`navigation_decision`): ``http(s)`` links to
  anything else open in the default browser, other schemes are dropped, ``file://`` access is off.
- Closing the window or Cmd+Q stops the server (the window's ``closing`` event, which pywebview
  also fires from ``applicationShouldTerminate:`` before ``terminate:`` exits the process).
- WebView storage (localStorage: chosen profile, theme, layout, view filters) lives where WebKit
  keeps it for the app, ``~/Library/WebKit/<bundle id>/`` (pywebview's macOS backend always uses
  the default data store; ``storage_path`` is not honoured there), not in the data dir. The SPA
  keeps no amounts or other financial data there (planned deposits are stored on the server).
- Links (packaged app only): ``finanse://`` URLs and clicks on the app's notifications open the
  matching view (``notify.install_app_handlers`` + ``notify.LinkRouter``); a link that launched
  the app is kept until the window loads the dashboard.
- App name and Dock icon: the packaged app takes them from its bundle; a run from the source tree
  (no bundle, macOS would show the Python launcher) sets the menu bar name to :data:`TITLE` and the
  icon from ``packaging/icon/finanse-1024.png``.
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
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from ..core import locks, paths, runtime, security
from . import DEBUG_ENV, notify

log = logging.getLogger("finanse.desktop")

TITLE = "cashU"
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


class PrivateRotatingFileHandler(logging.handlers.RotatingFileHandler):
    """A rotating log whose every file is owner-only (0600): ``doRollover`` reopens the base file
    with plain ``open()``, which would follow the umask (0644) after the first rotation."""

    def _open(self):
        fd = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        if os.name == "posix":
            os.fchmod(fd, 0o600)  # a file left by an older version with another mode
        return open(fd, self.mode, encoding=self.encoding, errors=self.errors)


def setup_logging(*, requests: bool = False) -> Path:
    """Warnings and errors of the app (and uvicorn) to ``<data dir>/logs/app.log`` (0600);
    ``requests`` adds the request log (method, path, status), for debugging only."""
    path = log_path()
    paths.ensure_private_dir(paths.data_dir())  # first launch: the data dir itself 0700, too
    paths.ensure_private_dir(path.parent)
    handler = PrivateRotatingFileHandler(path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
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


def socket_options(os_name: str | None = None) -> list[tuple[int, int, int]]:
    """``setsockopt`` calls before ``bind``. POSIX: ``SO_REUSEADDR`` (rebind a remembered port in
    TIME_WAIT; a second bind of the same address is still refused there). Windows: never
    ``SO_REUSEADDR`` (it lets another process bind the same port and receive the window's
    requests, token header included) but ``SO_EXCLUSIVEADDRUSE``, as asyncio does."""
    if (os_name or os.name) == "posix":
        return [(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)]
    exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
    return [(socket.SOL_SOCKET, exclusive, 1)] if exclusive is not None else []


def bind_loopback(preferred: int | None = None) -> socket.socket:
    """A TCP socket bound to 127.0.0.1: on ``preferred`` when it is free, else on a random port."""
    for port in ([preferred] if preferred else []) + [0]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        for level, option, value in socket_options():
            sock.setsockopt(level, option, value)
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

DEV_ICON = Path(__file__).resolve().parents[3] / "packaging" / "icon" / "finanse-1024.png"


def use_dev_identity(icon: Path = DEV_ICON) -> bool:
    """Show the app name in the menu bar and the app icon in the Dock when running from the source
    tree (macOS); the packaged app already has both in its bundle. Must run before the
    ``NSApplication`` is created. False when not applicable or not possible."""
    if sys.platform != "darwin" or runtime.frozen() or not icon.is_file():
        return False
    try:
        from AppKit import NSApplication, NSBundle, NSImage
    except ImportError:
        return False
    info = NSBundle.mainBundle().infoDictionary()
    if info is not None:
        info["CFBundleName"] = TITLE  # the Python launcher's bundle; read when the app starts
    image = NSImage.alloc().initWithContentsOfFile_(str(icon))
    if image is None:
        return False
    NSApplication.sharedApplication().setApplicationIconImage_(image)
    return True


_PAGE = """<!doctype html><html lang="pl"><head><meta charset="utf-8"><style>
:root {{ color-scheme: light dark; }}
body {{ font: 14px -apple-system, system-ui, sans-serif; display: flex; align-items: center;
  justify-content: center; height: 100vh; margin: 0; background: #fff; color: #222; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #141414; color: #ddd; }} }}
main {{ max-width: 560px; padding: 24px; }} code {{ font-size: 12px; }}
</style></head><body><main>{body}</main></body></html>"""

LOADING_HTML = _PAGE.format(body="<p>Uruchamianie cashU…</p>")


def error_html(message: str, log_file: Path | None) -> str:
    where = (
        f"<p>Szczegóły w logu: <code>{html.escape(str(log_file))}</code></p>" if log_file else ""
    )
    return _PAGE.format(
        body=f"<h2>Nie udało się uruchomić cashU</h2><p>{html.escape(message)}</p>{where}"
    )


def window_size(screens: list | None) -> tuple[int, int]:
    """The default size, shrunk to the main screen (never below the minimum size)."""
    width, height = DEFAULT_SIZE
    if screens:
        screen = screens[0]
        width = min(width, int(screen.width) - SCREEN_MARGIN)
        height = min(height, int(screen.height) - SCREEN_MARGIN)
    return max(width, MIN_SIZE[0]), max(height, MIN_SIZE[1])


# --------------------------------------------------------------------------- #
# Token bridge and navigation policy
# --------------------------------------------------------------------------- #


def _same_origin(url: str, origin: str) -> bool:
    """``url`` is on ``origin`` (``http://127.0.0.1:<port>``): exact scheme, host and port."""
    try:
        parts, own = urlsplit(url), urlsplit(origin)
        return (parts.scheme, parts.hostname, parts.port) == (own.scheme, own.hostname, own.port)
    except ValueError:
        return False


def token_bridge(window, cfg: security.SecurityConfig) -> Callable[[], str | None]:
    """The function exposed to the window as ``window.pywebview.api.token()`` (PK1).

    Exposed with ``window.expose`` (not as a ``js_api`` object, whose attributes the bridge would
    let a page walk): the page can call exactly this one function. It answers only while the
    window shows the app's own origin, so a foreign page (which the navigation policy keeps out
    anyway) never gets the token."""

    def token() -> str | None:
        try:
            current = window.get_current_url() or ""
        except Exception:  # noqa: BLE001 - unknown page: refuse
            current = ""
        if not _same_origin(current, cfg.origin):
            log.warning("token request from a page outside the app refused")
            return None
        return cfg.token

    return token


ALLOW, EXTERNAL, BLOCK = "allow", "external", "block"


def navigation_decision(url: str, origin: str) -> str:
    """Where a navigation of the window goes (PK5): the app's own origin (and its blob: URLs, the
    CSV export) and ``about:`` pages load in the window; other ``http(s)`` URLs open in the
    default browser; every other scheme (``file:``, ``javascript:``, custom app schemes) is
    dropped."""
    if url.startswith("about:"):
        return ALLOW
    if url.startswith("blob:"):
        return ALLOW if _same_origin(url[len("blob:"):], origin) else BLOCK
    if _same_origin(url, origin):
        return ALLOW
    scheme = urlsplit(url).scheme.lower() if url else ""
    return EXTERNAL if scheme in ("http", "https") else BLOCK


def open_external(url: str) -> None:
    try:
        webbrowser.open(url, 2, True)
    except Exception:  # noqa: BLE001
        log.warning("could not open a link in the browser")


_guard: dict = {"origin": None, "installed": False}


def install_navigation_guard(origin: str) -> bool:
    """Pin the window to ``origin`` (macOS, pywebview's cocoa backend; PK5).

    pywebview lets every main-frame navigation through and opens only ``target=_blank`` link
    clicks in the browser. Its WKWebView delegate is replaced by a subclass (before the window is
    created) that asks :func:`navigation_decision` first; downloads (the CSV export) and pywebview's
    own handling continue through the original methods. False when the backend is not available
    (another platform): the window then relies on the SPA having no foreign links."""
    _guard["origin"] = origin
    if _guard["installed"]:
        return True
    if sys.platform != "darwin":
        return False
    try:
        import objc
        from webview.platforms import cocoa
    except Exception:  # noqa: BLE001 - no pyobjc / backend
        log.warning("navigation guard not installed (no cocoa backend)")
        return False
    base = cocoa.BrowserView.BrowserDelegate
    cancel = getattr(cocoa.WebKit, "WKNavigationActionPolicyCancel", 0)

    class FinanseBrowserDelegate(base):
        def webView_decidePolicyForNavigationAction_decisionHandler_(self, webview, action, handler):
            if not action.shouldPerformDownload():
                url = str(action.request().URL().absoluteString() or "")
                decision = navigation_decision(url, _guard["origin"] or "")
                if decision != ALLOW:
                    if decision == EXTERNAL:
                        open_external(url)
                    handler(cancel)
                    return
            parent = objc.super(FinanseBrowserDelegate, self)
            parent.webView_decidePolicyForNavigationAction_decisionHandler_(webview, action, handler)

        def webView_createWebViewWithConfiguration_forNavigationAction_windowFeatures_(
            self, webview, config, action, features
        ):
            # target=_blank links and window.open(): never a second window.
            url = str(action.request().URL().absoluteString() or "")
            if navigation_decision(url, _guard["origin"] or "") == EXTERNAL:
                open_external(url)

    cocoa.BrowserView.BrowserDelegate = FinanseBrowserDelegate
    _guard["installed"] = True
    return True


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


ERROR_PAGE_BASE = ""
"""Base URL of the boot error page. pywebview's ``load_html`` defaults to a ``file://`` base (the app
bundle), which WebKit reports to the navigation delegate as the request URL, so the PK5 guard would
cancel the page; an empty base is reported as ``about:blank`` (allowed), like the loading page that
pywebview itself loads with ``''`` (F7 review R1)."""


def _boot(
    window,
    server: ServerThread,
    launch: Launch,
    log_file: Path | None,
    router: notify.LinkRouter | None = None,
) -> None:
    """Runs in pywebview's worker thread once the window exists: start the server, show the app
    (on the view of a link that arrived meanwhile). Nothing escapes (PK7): pywebview runs this in a
    bare thread whose exceptions would only reach the discarded stderr of the app, leaving the
    window on the loading page; every failure is logged and shown in the window instead."""
    try:
        try:
            server.start()
        except DesktopError as e:
            launch.error = str(e)
            log.error("%s", e)
            window.load_html(error_html(str(e), log_file), ERROR_PAGE_BASE)
            return
        _remember(server.port)
        window.load_url(router.ready(window, server.url) if router is not None else server.url)
    except Exception as e:
        launch.error = launch.error or f"Unexpected error while opening the window: {e}"
        log.exception("the window could not be opened")
        try:
            window.load_html(error_html(launch.error, log_file), ERROR_PAGE_BASE)
        except Exception:
            log.exception("could not show the error page")


def _remember(port: int) -> None:
    """Best effort: the port for the next launch, and where the app runs from (PK11). A read-only
    or full disk must not keep the window from opening."""
    try:
        state = load_state()
        if state.get("port") != port:
            state["port"] = port
            save_state(state)
    except OSError as e:
        log.warning("could not remember the port: %s", e)
    try:
        runtime.note_app_location()
    except OSError as e:
        log.warning("could not record the app location: %s", e)


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
            webview.settings["ALLOW_FILE_URLS"] = False  # the window never needs file:// access
            webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False  # inspector via right click only
            if webview_module is None:  # the real pywebview: pin the window to the app (PK5)
                install_navigation_guard(cfg.origin)
                use_dev_identity()
            try:
                screens = list(webview.screens)
            except Exception:  # noqa: BLE001 - no screen info: default size
                screens = []
            width, height = window_size(screens)
            router = notify.LinkRouter()
            notify.install_app_handlers(router.open)  # Finanse.app only; before the event loop
            window = webview.create_window(
                TITLE,
                html=LOADING_HTML,
                width=width,
                height=height,
                min_size=MIN_SIZE,
                text_select=True,
                zoomable=True,
            )
            window.expose(token_bridge(window, cfg))  # window.pywebview.api.token() (PK1)
            # Window close and Cmd+Q both fire `closing` first; Cmd+Q then exits the process
            # without returning from webview.start (PK6), so the server stops here.
            window.events.closing += lambda: server.stop()
            try:
                webview.start(
                    _boot,
                    (window, server, launch, log_file, router),
                    debug=debug,
                    private_mode=False,
                )
            finally:
                server.stop()
    except locks.LockBusy:
        pid = running_pid()
        raise AlreadyRunning(pid, pid is not None and focus_process(pid)) from None
    return launch
