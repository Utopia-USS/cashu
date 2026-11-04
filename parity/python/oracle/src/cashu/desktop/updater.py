"""Auto-update of cashU.app through Sparkle 2 (macOS), with the dashboard as its only UI.

- Only a build given an update key ships ``Sparkle.framework`` and the ``SUFeedURL`` /
  ``SUPublicEDKey`` keys (``scripts/build_macos.sh``, packaging/README.md "Auto-update"). Every other
  build, a run from source and the tests have no updater.
- Nothing is downloaded without the owner. Sparkle checks the feed (an appcast in the latest GitHub
  release) once a day; a new version shows up in the dashboard's corner card (``UpdateNotice.tsx``)
  with "Aktualizuj" (download, verify, install, relaunch) and "Pomiń" (never offer this version
  again); closing the card reminds later. A download must carry the EdDSA signature of the release
  key and the same Developer ID as the running app, and is checked before it is unpacked. Installing
  replaces the bundle at the same path (the launchd job and the MCP lines stay valid). One anonymous
  GET of the feed; no system profile is sent.
- :class:`CashuUserDriver` takes the place of Sparkle's windows (an ``SPUUserDriver``): every prompt
  and progress step lands in :class:`Bridge`, which the API reads (``GET /api/system/update`` ->
  ``app``) and acts on (``POST /api/system/update/<install|skip|dismiss|check>``). Sparkle calls the
  driver on the main thread; the API hands its actions back there. A change is pushed to the window
  (a ``cashu-update`` DOM event) so the card follows at once.
- Daily checks can be turned off in Settings > Aplikacja (Sparkle keeps that in the app's user
  defaults). "Sprawdź aktualizacje…" in the app menu and "Sprawdź" in Settings check on demand.
- It runs only from ``/Applications`` (a translocated or moved copy would update the wrong place)
  and not with ``CASHU_UPDATE_CHECK=0``. For testing a build in another folder,
  ``CASHU_UPDATER_ANYWHERE=1`` lifts the location rule and ``CASHU_UPDATER_CHECK_NOW=1`` runs a
  background check once the window is up.
- Processes started from the old copy (an MCP server, a worker run) notice the replacement through
  ``core.runtime.bundle_replaced`` and stop.
"""

from __future__ import annotations

import logging
import plistlib
import sys
import threading
from collections.abc import Callable
from pathlib import Path

from .. import __version__
from ..core import runtime, updates
from ..core.env import env

log = logging.getLogger("cashu.desktop")

FRAMEWORK = "Sparkle.framework"
CHECK_ENV = "CASHU_UPDATE_CHECK"  # = core/updates.py, which shares the switch
ANYWHERE_ENV = "CASHU_UPDATER_ANYWHERE"
CHECK_NOW_ENV = "CASHU_UPDATER_CHECK_NOW"
MENU_TITLE = "Sprawdź aktualizacje…"
PUSH_JS = "window.dispatchEvent(new Event('cashu-update'))"

# SPUUserUpdateChoice
SKIP, INSTALL, DISMISS = 0, 1, 2

# Stages the dashboard shows. Sparkle's own cycle ends with dismissUpdateInstallation, which clears
# the first four; a result (up to date, an error) stays until the owner closes it.
IDLE, CHECKING, AVAILABLE, DOWNLOADING, INSTALLING = "idle", "checking", "available", "downloading", "installing"
UP_TO_DATE, ERROR = "up_to_date", "error"
_IN_CYCLE = {CHECKING, AVAILABLE, DOWNLOADING, INSTALLING}

# Sparkle keeps only weak references: the updater, its driver and the menu target live here.
_updater = None
_driver = None
_menu_target = None


class Bridge:
    """The updater as the API sees it (``core.updates.AppUpdater``) and the state the driver
    reports into. Sparkle's reply blocks are called on the main thread only (``call_main``)."""

    def __init__(self, auto: bool, call_main: Callable[..., None], check: Callable[[], None]) -> None:
        self._lock = threading.Lock()
        self._call_main = call_main
        self._check = check
        self.on_change: Callable[[], None] | None = None
        self._auto = auto
        self._stage = IDLE
        self._version: str | None = None
        self._progress: float | None = None
        self._error: str | None = None
        self._reply: Callable[[int], None] | None = None
        self._expected = 0
        self._received = 0

    # -- read ------------------------------------------------------------------------------------

    def state(self) -> dict:
        with self._lock:
            return {
                "auto": self._auto,
                "stage": self._stage,
                "version": self._version,
                "progress": self._progress,
                "error": self._error,
            }

    def _set(self, **changes) -> None:
        with self._lock:
            for key, value in changes.items():
                setattr(self, f"_{key}", value)
        if self.on_change is not None:
            try:
                self.on_change()
            except Exception:
                log.exception("could not push the update state to the window")

    # -- Sparkle (main thread, through CashuUserDriver) ------------------------------------------

    def checking(self) -> None:
        self._set(stage=CHECKING, error=None)

    def found(self, version: str, reply: Callable[[int], None]) -> None:
        self._set(stage=AVAILABLE, version=version, progress=None, error=None, reply=reply)

    def not_found(self) -> None:
        self._set(stage=UP_TO_DATE, version=None, progress=None, reply=None)

    def failed(self, message: str) -> None:
        log.warning("update failed: %s", message)
        self._set(stage=ERROR, error=message, progress=None, reply=None)

    def download_started(self) -> None:
        self._set(stage=DOWNLOADING, progress=0.0, expected=0, received=0)

    def download_expected(self, length: int) -> None:
        with self._lock:
            self._expected = length

    def download_received(self, length: int) -> None:
        with self._lock:
            self._received += length
            expected, received = self._expected, self._received
        if expected:
            self._set(progress=min(received / expected, 1.0))

    def installing(self) -> None:
        self._set(stage=INSTALLING, progress=None)

    def cycle_ended(self) -> None:
        with self._lock:
            in_cycle = self._stage in _IN_CYCLE
        if in_cycle:
            self._set(stage=IDLE, progress=None, reply=None)

    # -- the owner (API threads) -----------------------------------------------------------------

    def _answer(self, choice: int, stage: str) -> bool:
        with self._lock:
            reply = self._reply if self._stage == AVAILABLE else None
            if reply is not None:
                self._reply = None
        if reply is None:
            return False
        self._set(stage=stage)
        self._call_main(reply, choice)
        return True

    def install(self) -> bool:
        """"Aktualizuj": download, verify and install the offered version, then relaunch."""
        return self._answer(INSTALL, DOWNLOADING)

    def skip(self) -> bool:
        """"Pomiń": this version is not offered again (a check the owner asks for still finds it)."""
        return self._answer(SKIP, IDLE)

    def dismiss(self) -> bool:
        """The card's close button: an offer is postponed (Sparkle reminds later), a result is
        cleared. False when there is nothing to close."""
        if self._answer(DISMISS, IDLE):
            return True
        with self._lock:
            done = self._stage in (UP_TO_DATE, ERROR)
        if done:
            self._set(stage=IDLE, error=None)
        return done

    def check(self) -> bool:
        """Check now, as the menu item does. False while a check or an update is under way."""
        with self._lock:
            busy = self._stage in _IN_CYCLE
        if busy:
            return False
        self._call_main(self._check)
        return True

    def set_auto(self, enabled: bool) -> None:
        with self._lock:
            self._auto = enabled
        self._call_main(_apply_auto, enabled)


def framework_path(bundle: Path) -> Path:
    return bundle / "Contents" / "Frameworks" / FRAMEWORK


def _info(bundle: Path | None) -> dict:
    if bundle is None:
        return {}
    try:
        data = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def unavailable_reason(bundle: Path | None, info: dict, *, translocated: bool = False) -> str | None:
    """Why the updater does not run here; None when it can."""
    if sys.platform != "darwin" or bundle is None:
        return "not the packaged macOS app"
    if translocated:
        return "the app runs from a temporary location (App Translocation)"
    if not str(bundle).startswith("/Applications/") and env(ANYWHERE_ENV) != "1":
        return "the app does not run from /Applications"
    if env(CHECK_ENV) == "0":
        return f"update checks are off ({CHECK_ENV}=0)"
    if not info.get("SUFeedURL") or not info.get("SUPublicEDKey"):
        return "this build has no update feed"
    if not framework_path(bundle).is_dir():
        return f"this build has no {FRAMEWORK}"
    return None


def display_version(short: str, build: str) -> str:
    """What the dashboard names the update: the marketing version, plus the build when that alone
    would read like the running version (a rebuild of the same release)."""
    return f"{short} ({build})" if short == __version__ and build and build != short else short


def _bridge() -> Bridge | None:
    bridge = updates.app_updater()
    return bridge if isinstance(bridge, Bridge) else None


def _error_text(error) -> str:
    try:
        return str(error.localizedDescription()) if error is not None else "unknown error"
    except Exception:  # noqa: BLE001 - whatever Sparkle hands over, the card gets a message
        return "unknown error"


# Block arguments of the driver's methods (index 2 = the first Objective-C argument). PyObjC needs
# their signatures registered before the class is defined, or it cannot call them.
_VOID_BLOCK = {"callable": {"retval": {"type": b"v"}, "arguments": {0: {"type": b"^v"}}}}
_CHOICE_BLOCK = {
    "callable": {"retval": {"type": b"v"}, "arguments": {0: {"type": b"^v"}, 1: {"type": b"q"}}}
}
_OBJECT_BLOCK = {
    "callable": {"retval": {"type": b"v"}, "arguments": {0: {"type": b"^v"}, 1: {"type": b"@"}}}
}
_BLOCKS = {
    b"showUpdatePermissionRequest:reply:": {3: _OBJECT_BLOCK},
    b"showUserInitiatedUpdateCheckWithCancellation:": {2: _VOID_BLOCK},
    b"showUpdateFoundWithAppcastItem:state:reply:": {4: _CHOICE_BLOCK},
    b"showUpdateNotFoundWithError:acknowledgement:": {3: _VOID_BLOCK},
    b"showUpdaterError:acknowledgement:": {3: _VOID_BLOCK},
    b"showDownloadInitiatedWithCancellation:": {2: _VOID_BLOCK},
    b"showReadyToInstallAndRelaunch:": {2: _CHOICE_BLOCK},
    b"showInstallingUpdateWithApplicationTerminated:retryTerminatingApplication:": {3: _VOID_BLOCK},
    b"showUpdateInstalledAndRelaunched:acknowledgement:": {3: _VOID_BLOCK},
}


def _driver_classes():
    """CashuUserDriver (the SPUUserDriver) and the menu item's target, defined once Sparkle is
    loaded."""
    import objc
    from AppKit import NSApp
    from Foundation import NSObject

    for selector, arguments in _BLOCKS.items():
        objc.registerMetaDataForSelector(b"NSObject", selector, {"arguments": arguments})
    response_cls = objc.lookUpClass("SUUpdatePermissionResponse")
    try:
        protocols = [objc.protocolNamed("SPUUserDriver")]
    except objc.ProtocolError:  # the typed selectors below carry the signatures anyway
        protocols = []

    class CashuUserDriver(NSObject, protocols=protocols):
        @objc.typedSelector(b"v@:@@?")
        def showUpdatePermissionRequest_reply_(self, _request, reply):
            # Info.plist turns daily checks on, so Sparkle should not ask; if it does: checks on,
            # no background downloads, no system profile.
            reply(response_cls.alloc().initWithAutomaticUpdateChecks_sendSystemProfile_(True, False))

        @objc.typedSelector(b"v@:@?")
        def showUserInitiatedUpdateCheckWithCancellation_(self, _cancel):
            if (bridge := _bridge()) is not None:
                bridge.checking()

        @objc.typedSelector(b"v@:@@@?")
        def showUpdateFoundWithAppcastItem_state_reply_(self, item, _state, reply):
            bridge = _bridge()
            if bridge is None:
                reply(DISMISS)
                return
            short = str(item.displayVersionString() or "")
            build = str(item.versionString() or "")
            bridge.found(display_version(short or build, build), reply)

        @objc.typedSelector(b"v@:@")
        def showUpdateReleaseNotesWithDownloadData_(self, _data):
            pass

        @objc.typedSelector(b"v@:@")
        def showUpdateReleaseNotesFailedToDownloadWithError_(self, _error):
            pass

        @objc.typedSelector(b"v@:@@?")
        def showUpdateNotFoundWithError_acknowledgement_(self, _error, acknowledgement):
            if (bridge := _bridge()) is not None:
                bridge.not_found()
            acknowledgement()

        @objc.typedSelector(b"v@:@@?")
        def showUpdaterError_acknowledgement_(self, error, acknowledgement):
            if (bridge := _bridge()) is not None:
                bridge.failed(_error_text(error))
            acknowledgement()

        @objc.typedSelector(b"v@:@?")
        def showDownloadInitiatedWithCancellation_(self, _cancel):
            if (bridge := _bridge()) is not None:
                bridge.download_started()

        @objc.typedSelector(b"v@:Q")
        def showDownloadDidReceiveExpectedContentLength_(self, length):
            if (bridge := _bridge()) is not None:
                bridge.download_expected(int(length))

        @objc.typedSelector(b"v@:Q")
        def showDownloadDidReceiveDataOfLength_(self, length):
            if (bridge := _bridge()) is not None:
                bridge.download_received(int(length))

        @objc.typedSelector(b"v@:")
        def showDownloadDidStartExtractingUpdate(self):
            if (bridge := _bridge()) is not None:
                bridge.installing()

        @objc.typedSelector(b"v@:d")
        def showExtractionReceivedProgress_(self, _progress):
            pass

        @objc.typedSelector(b"v@:@?")
        def showReadyToInstallAndRelaunch_(self, reply):
            reply(INSTALL)  # the owner chose "Aktualizuj" already

        @objc.typedSelector(b"v@:B@?")
        def showInstallingUpdateWithApplicationTerminated_retryTerminatingApplication_(
            self, _terminated, _retry
        ):
            if (bridge := _bridge()) is not None:
                bridge.installing()

        @objc.typedSelector(b"v@:B@?")
        def showUpdateInstalledAndRelaunched_acknowledgement_(self, _relaunched, acknowledgement):
            acknowledgement()

        @objc.typedSelector(b"v@:")
        def showUpdateInFocus(self):
            NSApp.activateIgnoringOtherApps_(True)

        @objc.typedSelector(b"v@:")
        def dismissUpdateInstallation(self):
            if (bridge := _bridge()) is not None:
                bridge.cycle_ended()

    class CashuUpdateMenuTarget(NSObject):
        @objc.typedSelector(b"v@:@")
        def checkForUpdates_(self, _sender):
            _check_now()

        @objc.typedSelector(b"B@:@")
        def validateMenuItem_(self, _item):
            return bool(_updater is not None and _updater.canCheckForUpdates())

    return CashuUserDriver, CashuUpdateMenuTarget


def _call_main(fn: Callable, *args) -> None:
    from PyObjCTools import AppHelper

    AppHelper.callAfter(fn, *args)


def _check_now() -> None:
    """Main thread: a check the owner asked for (finds a skipped version too)."""
    if _updater is not None and _updater.canCheckForUpdates():
        _updater.checkForUpdates()


def _apply_auto(enabled: bool) -> None:
    """Main thread: Sparkle keeps it in the app's user defaults."""
    if _updater is not None:
        _updater.setAutomaticallyChecksForUpdates_(enabled)


def start() -> bool:
    """Start Sparkle (main thread, before the event loop). False when it does not run here."""
    global _updater, _driver, _menu_target
    if _updater is not None:
        return True
    bundle = runtime.app_bundle()
    reason = unavailable_reason(bundle, _info(bundle), translocated=runtime.translocated())
    if reason:
        log.info("updater off: %s", reason)
        return False
    try:
        import objc
        from Foundation import NSBundle

        objc.loadBundle("Sparkle", {}, bundle_path=str(framework_path(bundle)))
        driver_cls, target_cls = _driver_classes()
        _driver = driver_cls.alloc().init()
        _menu_target = target_cls.alloc().init()
        main = NSBundle.mainBundle()
        updater = objc.lookUpClass("SPUUpdater").alloc()
        updater = updater.initWithHostBundle_applicationBundle_userDriver_delegate_(
            main, main, _driver, None
        )
        auto = bool(updater.automaticallyChecksForUpdates())
        updates.register_app_updater(Bridge(auto, _call_main, _check_now))
        # PyObjC returns (ok, error) only when it knows the NSError** argument; without Sparkle's
        # bridge metadata it is the bare BOOL.
        result = updater.startUpdater_(None)
        ok, error = result if isinstance(result, tuple) else (bool(result), None)
        if not ok:
            raise RuntimeError(_error_text(error) if error is not None else "startUpdater failed")
        _updater = updater
    except Exception:  # an updater failure never keeps the window from opening
        log.exception("could not start the updater")
        updates.register_app_updater(None)
        _updater = _driver = _menu_target = None
        return False
    log.info("updater started (Sparkle, feed %s, daily checks %s)", _info(bundle).get("SUFeedURL"), auto)
    return True


def attach_window(window) -> None:
    """Push every state change to ``window`` as a ``cashu-update`` event (the card re-reads the
    state). Off the main thread: pywebview's evaluate_js waits for the main thread."""
    bridge = _bridge()
    if bridge is None:
        return

    def push() -> None:
        threading.Thread(target=_push, args=(window,), name="cashu-update-push", daemon=True).start()

    bridge.on_change = push


def _push(window) -> None:
    try:
        window.evaluate_js(PUSH_JS)
    except Exception:  # the window is closing or not loaded yet: the card's own poll catches up
        log.debug("update push skipped", exc_info=True)


def add_menu_item() -> bool:
    """Put "Sprawdź aktualizacje…" right under "About" in the app menu (main thread, once the menu
    exists)."""
    if _updater is None or _menu_target is None:
        return False
    from AppKit import NSApp, NSMenuItem

    menu = NSApp.mainMenu() if NSApp is not None else None
    if menu is None or menu.numberOfItems() == 0:
        return False
    app_menu = menu.itemAtIndex_(0).submenu()
    if app_menu is None or app_menu.itemWithTitle_(MENU_TITLE) is not None:
        return False
    item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
        MENU_TITLE, "checkForUpdates:", ""
    )
    item.setTarget_(_menu_target)
    app_menu.insertItem_atIndex_(item, min(1, app_menu.numberOfItems()))
    if env(CHECK_NOW_ENV) == "1":
        _updater.checkForUpdatesInBackground()
    return True


def add_menu_item_later() -> None:
    """:func:`add_menu_item` from another thread (pywebview's boot thread)."""
    if _updater is None:
        return
    try:
        _call_main(add_menu_item)
    except Exception:
        log.exception("could not add the update menu item")
