"""Native notifications of the packaged app (macOS) and its ``cashu://`` links.

Three pieces, all inert outside ``cashU.app``:

- **The helper** (``helper_main``): ``cashU.app/Contents/MacOS/cashu --notify-helper`` reads one
  notification as JSON on stdin and posts it with ``UNUserNotificationCenter`` (UserNotifications
  through pyobjc). Running from the bundle is what makes macOS show it as cashU with the app
  icon and apply the user's notification settings for cashU. Permission is requested on first
  use (macOS asks the user once); a denied permission, or a prompt not answered within
  ``AUTH_WAIT``, is reported, never routed around. The answer is one JSON line on stdout plus an
  exit code (``core/worker/notifier_app.py`` holds both sides of the protocol).
- **Links**: a notification carries a ``cashu://`` link in its ``userInfo``
  (``cashu://signal/<profile>/<id>``, ``cashu://review/<profile>``,
  ``cashu://investments/<profile>``, ``cashu://open``). ``link_to_hash`` turns a link into the
  dashboard's hash route (``#/<profile>/investments.portfolio/?signal=<id>``); anything else is
  ignored. Links come from outside the app (any program can open a URL), so only these shapes
  with a slug-shaped profile and a numeric id are accepted.
- **The app side** (``install_app_handlers`` + ``LinkRouter``, used by ``shell.run``): the
  ``cashu`` URL scheme (Info.plist ``CFBundleURLTypes``) arrives as a ``GURL`` Apple event, a
  click on a notification as a ``UNUserNotificationCenterDelegate`` callback; both hand the link
  to the router, which navigates the window (or keeps the link until the window has loaded, when
  the click started the app).
"""

from __future__ import annotations

import functools
import json
import logging
import re
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import IO, Any, Protocol
from urllib.parse import unquote, urlsplit

from ..core import runtime
from ..core.worker.notifier import LEGACY_LINK_SCHEME, LINK_SCHEME
from ..core.worker.notifier_app import EXIT_BY_STATUS, HELPER_ARG

log = logging.getLogger("cashu.desktop")

__all__ = ["HELPER_ARG", "LinkRouter", "helper_main", "install_app_handlers", "link_to_hash"]

AUTH_WAIT = 30.0  # seconds the helper waits for the user's answer to the permission prompt
POST_WAIT = 10.0  # seconds for the settings query and for posting
MAX_INPUT = 16_384
INVESTMENTS_VIEW = "investments.portfolio"
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_ID = re.compile(r"[0-9]{1,12}")
_GROUP = re.compile(r"[A-Za-z0-9._-]{1,128}")
MAX_LINK = 512

# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #


def link_to_hash(url: object) -> str | None:
    """The dashboard hash route for a ``cashu://`` link (or ``finanse://``, the legacy name of
    notifications posted before the rename): ``""`` = just bring the app to the front, None = not
    a link this app opens."""
    if not isinstance(url, str) or len(url) > MAX_LINK:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in (LINK_SCHEME, LEGACY_LINK_SCHEME) or parts.query or parts.fragment:
        return None
    kind = parts.netloc
    segs = [unquote(s) for s in parts.path.split("/") if s]
    if kind == "open" and not segs:
        return ""
    if not segs or not _SLUG.fullmatch(segs[0]):
        return None
    slug = segs[0]
    if kind == "signal" and len(segs) == 2 and _ID.fullmatch(segs[1]):
        return f"#/{slug}/{INVESTMENTS_VIEW}/?signal={int(segs[1])}"
    if kind == "review" and len(segs) == 1:
        return f"#/{slug}/{INVESTMENTS_VIEW}/?review=1"
    if kind == "investments" and len(segs) == 1:
        return f"#/{slug}/{INVESTMENTS_VIEW}"
    return None


def _spawn(target: Callable[..., object], *args: object) -> None:
    threading.Thread(target=target, args=args, name="cashu-link", daemon=True).start()


class LinkRouter:
    """Opens ``cashu://`` links in the window. Before the window has loaded the dashboard the
    latest link is kept and ``ready`` folds it into the first URL; afterwards a link changes the
    hash route in place (no reload, the page keeps its state) and brings the window forward.

    Window calls run in a separate thread: the Apple event and the notification callbacks arrive
    on the main thread, where pywebview's blocking calls would deadlock."""

    def __init__(self, *, spawn: Callable[..., None] | None = None) -> None:
        self._lock = threading.Lock()
        self._spawn = spawn  # None = a daemon thread (``_spawn``)
        self._window: Any = None
        self._base: str | None = None
        self._pending: str | None = None

    def ready(self, window: Any, base_url: str) -> str:
        """The window is about to load ``base_url``: returns the URL to load (with a pending
        link's route) and from now on navigates the window directly."""
        with self._lock:
            self._window, self._base = window, base_url
            pending, self._pending = self._pending, None
        return base_url + pending if pending else base_url

    def open(self, url: object) -> bool:
        target = link_to_hash(url)
        if target is None:
            log.warning("ignored a link the app does not open")
            return False
        with self._lock:
            window, base = self._window, self._base
            if window is None:
                if target:
                    self._pending = target
                return True
        (self._spawn or _spawn)(self._navigate, window, base, target)
        return True

    @staticmethod
    def _navigate(window: Any, base: str, target: str) -> None:
        try:
            if target:
                current = None
                try:
                    current = window.get_current_url()
                except Exception:  # noqa: BLE001 - unknown page: load the route instead
                    current = None
                if isinstance(current, str) and current.startswith(base):
                    window.run_js(f"location.hash = {json.dumps(target)};")
                else:
                    window.load_url(base + target)
            window.show()
        except Exception:
            log.exception("could not open a link in the window")


# --------------------------------------------------------------------------- #
# The helper (cashU.app/Contents/MacOS/cashu --notify-helper)
# --------------------------------------------------------------------------- #


class Unavailable(RuntimeError):
    """UserNotifications cannot be used in this process (not the app bundle, no framework)."""


@dataclass(frozen=True)
class NativeRequest:
    identifier: str
    title: str
    subtitle: str
    message: str
    url: str | None

    @classmethod
    def from_payload(cls, data: object) -> NativeRequest:
        if not isinstance(data, dict):
            raise TypeError("expected a JSON object")

        def text(key: str, limit: int, required: bool = False) -> str:
            value = data.get(key)
            if value is None and not required:
                return ""
            if not isinstance(value, str) or (required and not value.strip()):
                raise TypeError(f"{key}: expected text")
            return " ".join(value.split())[:limit]

        group = data.get("group")
        if group is not None and (not isinstance(group, str) or not _GROUP.fullmatch(group)):
            raise TypeError("group: expected letters, digits, '.', '_' or '-'")
        url = data.get("url")
        if url is not None and link_to_hash(url) is None:
            url = None  # never attach a link the app would not open
        return cls(
            identifier=group or f"cashu-{uuid.uuid4().hex}",
            title=text("title", 120, required=True),
            subtitle=text("subtitle", 120),
            message=text("message", 400, required=True),
            url=url,
        )


class Center(Protocol):
    """The part of UNUserNotificationCenter the helper uses (a fake in tests)."""

    def authorization_status(self, timeout: float) -> str | None:
        """not_determined | denied | authorized | provisional | ephemeral; None = no answer."""

    def request_authorization(self, timeout: float) -> tuple[bool | None, str | None]:
        """(granted, error); granted None = the user has not answered yet."""

    def add(self, request: NativeRequest, timeout: float) -> tuple[bool, str | None]:
        """(posted, error)."""


_TIMEOUT = object()
AUTH_STATUS = {0: "not_determined", 1: "denied", 2: "authorized", 3: "provisional", 4: "ephemeral"}


class _Box:
    """A value delivered by a completion handler (any thread); ``wait`` keeps the main run loop
    turning meanwhile, in case the framework answers on the main queue."""

    def __init__(self, pump: Callable[[float], None] | None = None) -> None:
        self._event = threading.Event()
        self._pump = pump
        self.value: Any = None

    def put(self, value: Any) -> None:
        self.value = value
        self._event.set()

    def wait(self, timeout: float) -> Any:
        deadline = time.monotonic() + timeout
        while not self._event.is_set():
            left = deadline - time.monotonic()
            if left <= 0:
                return _TIMEOUT
            if self._pump is not None:
                self._pump(min(left, 0.05))
            self._event.wait(min(left, 0.05))
        return self.value


def _describe(error: Any) -> str | None:
    if error is None:
        return None
    try:
        return f"{error.domain()} {error.code()}: {error.localizedDescription()}"[:300]
    except Exception:  # noqa: BLE001
        return str(error)[:300]


class NativeCenter:
    """UNUserNotificationCenter through pyobjc. Only constructed inside cashU.app."""

    def __init__(self) -> None:
        if sys.platform != "darwin":
            raise Unavailable("native notifications need macOS")
        if runtime.app_bundle() is None:
            raise Unavailable("not running from cashU.app")
        try:
            import UserNotifications as un
            from Foundation import NSDate, NSDefaultRunLoopMode, NSRunLoop
        except ImportError as e:
            raise Unavailable(f"the UserNotifications framework is not available ({e})") from e
        self._un = un
        try:
            self._center = un.UNUserNotificationCenter.currentNotificationCenter()
        except Exception as e:
            raise Unavailable(f"no notification center for this process ({e})") from e

        def pump(seconds: float) -> None:
            NSRunLoop.currentRunLoop().runMode_beforeDate_(
                NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow_(seconds)
            )

        self._pump = pump

    def authorization_status(self, timeout: float) -> str | None:
        box = _Box(self._pump)
        self._center.getNotificationSettingsWithCompletionHandler_(
            lambda settings: box.put(int(settings.authorizationStatus()))
        )
        code = box.wait(timeout)
        return None if code is _TIMEOUT else AUTH_STATUS.get(code, "unknown")

    def request_authorization(self, timeout: float) -> tuple[bool | None, str | None]:
        un = self._un
        box = _Box(self._pump)
        options = un.UNAuthorizationOptionAlert | un.UNAuthorizationOptionSound
        self._center.requestAuthorizationWithOptions_completionHandler_(
            options, lambda granted, error: box.put((bool(granted), _describe(error)))
        )
        answer = box.wait(timeout)
        return (None, None) if answer is _TIMEOUT else answer

    def add(self, request: NativeRequest, timeout: float) -> tuple[bool, str | None]:
        un = self._un
        content = un.UNMutableNotificationContent.alloc().init()
        content.setTitle_(request.title)
        if request.subtitle:
            content.setSubtitle_(request.subtitle)
        content.setBody_(request.message)
        if request.url:
            content.setUserInfo_({"url": request.url})
        content.setSound_(un.UNNotificationSound.defaultSound())
        native = un.UNNotificationRequest.requestWithIdentifier_content_trigger_(
            request.identifier, content, None
        )
        box = _Box(self._pump)
        self._center.addNotificationRequest_withCompletionHandler_(
            native, lambda error: box.put(_describe(error))
        )
        error = box.wait(timeout)
        if error is _TIMEOUT:
            return False, "posting did not finish in time"
        return error is None, error


def post(
    center: Center,
    request: NativeRequest,
    *,
    auth_wait: float = AUTH_WAIT,
    post_wait: float = POST_WAIT,
) -> tuple[str, str | None]:
    """Ask for permission when macOS has not asked yet, then post. Returns (status, error) with
    status delivered | denied | pending | failed."""
    status = center.authorization_status(post_wait)
    if status is None:
        return "failed", "the notification settings did not answer"
    if status == "denied":
        return "denied", None
    if status == "not_determined":
        granted, error = center.request_authorization(auth_wait)
        if granted is None:
            return "pending", None
        if not granted:
            # No error: the user said no. An error: macOS refused to ask (e.g. a build it does
            # not accept), a technical failure the worker may route around.
            return ("failed", error) if error else ("denied", None)
    posted, error = center.add(request, post_wait)
    return ("delivered", None) if posted else ("failed", error or "posting failed")


def _answer(out: IO[str], status: str, error: str | None = None, **extra: object) -> int:
    body: dict[str, object] = {"status": status, **extra}
    if error:
        body["error"] = error
    out.write(json.dumps(body, ensure_ascii=False) + "\n")
    out.flush()
    return EXIT_BY_STATUS.get(status, EXIT_BY_STATUS["failed"])


def helper_main(
    argv: list[str],
    *,
    stdin: IO[str] | None = None,
    stdout: IO[str] | None = None,
    center_factory: Callable[[], Center] | None = None,
    auth_wait: float = AUTH_WAIT,
    post_wait: float = POST_WAIT,
) -> int:
    """``--notify-helper`` (one notification as JSON on stdin) or ``--notify-helper --status``
    (the permission state, nothing posted, nothing asked). Returns the exit code."""
    out = stdout or sys.stdout
    factory = center_factory or NativeCenter
    if argv == ["--status"]:
        try:
            center = factory()
        except Unavailable as e:
            return _answer(out, "unavailable", str(e))
        state = center.authorization_status(post_wait)
        bundle = runtime.app_bundle()
        out.write(json.dumps({"authorization": state or "no answer", "bundle": str(bundle)}) + "\n")
        return 0
    if argv:
        return _answer(out, "usage", f"unexpected arguments: {' '.join(argv)[:100]}")
    raw = (stdin or sys.stdin).read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return _answer(out, "usage", "input too long")
    try:
        request = NativeRequest.from_payload(json.loads(raw))
    except (ValueError, TypeError) as e:
        return _answer(out, "usage", str(e))
    try:
        center = factory()
    except Unavailable as e:
        return _answer(out, "unavailable", str(e))
    try:
        status, error = post(center, request, auth_wait=auth_wait, post_wait=post_wait)
    except Exception as e:  # noqa: BLE001 - reported to the worker, which may fall back
        return _answer(out, "failed", f"{type(e).__name__}: {e}"[:300])
    return _answer(out, status, error)


# --------------------------------------------------------------------------- #
# The app side: URL scheme + notification clicks (inside cashU.app only)
# --------------------------------------------------------------------------- #

K_INTERNET_EVENT_CLASS = int.from_bytes(b"GURL", "big")
K_AE_GET_URL = int.from_bytes(b"GURL", "big")
KEY_DIRECT_OBJECT = int.from_bytes(b"----", "big")
# UNNotificationPresentationOption: banner | list | sound, so a notification still shows while
# the app is in front.
PRESENT_OPTIONS = (1 << 4) | (1 << 3) | (1 << 1)

_handlers: list[Any] = []  # the ObjC handler objects (neither the AE manager nor UN retains them)
_on_link: Callable[[str], object] | None = None


def dispatch_link(url: object) -> None:
    """Hand a link from the OS to the registered callback; never raises."""
    callback = _on_link
    if callback is None or not isinstance(url, str):
        return
    try:
        callback(url)
    except Exception:
        log.exception("link handler failed")


def link_from_user_info(user_info: Any) -> str | None:
    try:
        url = user_info.get("url") if user_info is not None else None
    except Exception:  # noqa: BLE001
        return None
    return str(url) if url is not None else None


@functools.cache
def _objc_classes() -> tuple[Any, Any]:
    """The two ObjC classes (defined once per process; ObjC class names are global)."""
    import objc
    import UserNotifications as un
    from Foundation import NSObject

    default_action = un.UNNotificationDefaultActionIdentifier

    class CashuLinkHandler(NSObject):
        @objc.typedSelector(b"v@:@@")
        def handleGetURLEvent_withReplyEvent_(self, event, reply):
            try:
                desc = event.paramDescriptorForKeyword_(KEY_DIRECT_OBJECT)
                url = desc.stringValue() if desc is not None else None
            except Exception:  # noqa: BLE001
                url = None
            dispatch_link(url)

        @objc.typedSelector(b"v@:@")
        def willFinishLaunching_(self, note):
            # AppKit installs its own Apple event handlers while launching; ours goes last.
            _register_url_handler(self)

    class CashuNotificationDelegate(
        NSObject, protocols=[objc.protocolNamed("UNUserNotificationCenterDelegate")]
    ):
        # A Python exception must never travel back into the framework (it would become an
        # NSException in the caller): both callbacks catch everything.
        def userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(
            self, center, response, handler
        ):
            try:
                if response.actionIdentifier() == default_action:  # a click, not a dismissal
                    content = response.notification().request().content()
                    dispatch_link(link_from_user_info(content.userInfo()))
            except Exception:
                log.exception("could not read a notification click")
            try:
                handler()
            except Exception:
                log.exception("notification click completion failed")

        def userNotificationCenter_willPresentNotification_withCompletionHandler_(
            self, center, notification, handler
        ):
            try:
                handler(PRESENT_OPTIONS)
            except Exception:
                log.exception("notification presentation completion failed")

    return CashuLinkHandler, CashuNotificationDelegate


def _register_url_handler(handler: Any) -> None:
    from Foundation import NSAppleEventManager

    NSAppleEventManager.sharedAppleEventManager().setEventHandler_andSelector_forEventClass_andEventID_(
        handler, b"handleGetURLEvent:withReplyEvent:", K_INTERNET_EVENT_CLASS, K_AE_GET_URL
    )


def _install_url_handler() -> None:
    from AppKit import NSApplicationWillFinishLaunchingNotification
    from Foundation import NSNotificationCenter

    handler_cls, _ = _objc_classes()
    handler = handler_cls.alloc().init()
    _handlers.append(handler)
    _register_url_handler(handler)
    NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
        handler, b"willFinishLaunching:", NSApplicationWillFinishLaunchingNotification, None
    )


def _install_notification_delegate() -> None:
    import UserNotifications as un

    _, delegate_cls = _objc_classes()
    delegate = delegate_cls.alloc().init()
    _handlers.append(delegate)
    un.UNUserNotificationCenter.currentNotificationCenter().setDelegate_(delegate)


def install_app_handlers(on_link: Callable[[str], object]) -> bool:
    """Inside cashU.app (macOS): route ``cashu://`` URLs and notification clicks to
    ``on_link``. Call before the window's event loop starts (pywebview ``start``), so links that
    launched the app are not missed. Elsewhere (a checkout, tests) nothing happens: False."""
    global _on_link
    if sys.platform != "darwin" or runtime.app_bundle() is None:
        return False
    _on_link = on_link
    installed = False
    for what, step in (
        ("URL handler", _install_url_handler),
        ("notification delegate", _install_notification_delegate),
    ):
        try:
            step()
            installed = True
        except Exception:
            log.exception("could not install the %s", what)
    return installed
