"""Native notifications (F6 NT), app side: finanse:// links -> dashboard routes (strict: links
come from any program), the link router (pending until the window loads, then a hash change),
the notification helper with a fake notification center (permission on first use, denied /
pending / failed answers, the JSON protocol shared with the worker), the ObjC callbacks through
the bridge with fake objects, and the desktop shell wiring. Nothing is posted and no handler is
registered with the OS."""

from __future__ import annotations

import io
import json
import sys
import threading

import pytest
from test_desktop import FakeWebview, FakeWindow, _patch_server_app

from finanse.core import runtime, security
from finanse.core.worker import notifier_app as na
from finanse.core.worker.notifier import Notification, investments_link, review_link, signal_link
from finanse.desktop import entry, notify, shell

# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #


def test_link_to_hash_routes():
    assert notify.link_to_hash(signal_link("dom", 7)) == "#/dom/investments.portfolio/?signal=7"
    assert notify.link_to_hash(review_link("anna-k")) == "#/anna-k/investments.portfolio/?review=1"
    assert notify.link_to_hash(investments_link("p2")) == "#/p2/investments.portfolio"
    assert notify.link_to_hash("finanse://open") == ""
    assert (
        notify.link_to_hash("finanse://signal/dom/007") == "#/dom/investments.portfolio/?signal=7"
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://signal/dom/7",
        "javascript://signal/dom/7",
        "finanse://signal/Dom/7",  # slugs are lower-case
        "finanse://signal/dom/7/x",
        "finanse://signal/dom",
        "finanse://signal/dom/abc",
        "finanse://signal/dom/７",  # a full-width digit is not an id
        "finanse://signal/dom/1234567890123",
        "finanse://signal/%2E%2E/7",
        "finanse://signal/a%2Fb/7",
        "finanse://signal/dom%22%3Balert(1)/7",
        "finanse://signal/dom/7?x=1",
        "finanse://signal/dom/7#frag",
        "finanse://review",
        "finanse://open/extra",
        "finanse://delete/dom",
        "finanse://signal/" + "a" * 65 + "/7",
        "finanse://signal/dom/" + "1" * 600,
        "",
        None,
        42,
    ],
)
def test_link_to_hash_rejects_everything_else(url):
    assert notify.link_to_hash(url) is None


# --------------------------------------------------------------------------- #
# Link router
# --------------------------------------------------------------------------- #


class NavWindow:
    def __init__(self, current="http://127.0.0.1:5000/#/dom/overview", fail=False):
        self.current = current
        self.fail = fail
        self.calls: list[tuple] = []

    def get_current_url(self):
        return self.current

    def run_js(self, script):
        if self.fail:
            raise RuntimeError("webview gone")
        self.calls.append(("js", script))

    def load_url(self, url):
        self.calls.append(("url", url))

    def show(self):
        self.calls.append(("show",))


def sync_router() -> notify.LinkRouter:
    return notify.LinkRouter(spawn=lambda target, *args: target(*args))


BASE = "http://127.0.0.1:5000/"


def test_a_link_before_the_window_is_ready_opens_with_it():
    router = sync_router()
    assert router.open("finanse://signal/dom/3")
    assert router.open("finanse://signal/dom/4")  # the latest wins
    assert router.open("finanse://open")  # just "bring forward": keeps the pending route
    window = NavWindow()
    assert router.ready(window, BASE) == BASE + "#/dom/investments.portfolio/?signal=4"
    assert window.calls == []
    assert sync_router().ready(window, BASE) == BASE  # no link: the plain URL


def test_a_link_after_ready_changes_the_route_in_place():
    router = sync_router()
    window = NavWindow()
    router.ready(window, BASE)
    assert router.open("finanse://review/dom")
    assert window.calls == [
        ("js", 'location.hash = "#/dom/investments.portfolio/?review=1";'),
        ("show",),
    ]
    window.calls.clear()
    assert router.open("finanse://open")
    assert window.calls == [("show",)]


def test_router_loads_the_route_when_the_window_shows_another_page():
    router = sync_router()
    window = NavWindow(current=None)  # e.g. the loading or error page
    router.ready(window, BASE)
    router.open("finanse://investments/dom")
    assert window.calls == [("url", BASE + "#/dom/investments.portfolio"), ("show",)]


def test_router_ignores_foreign_links_and_survives_window_errors(caplog):
    router = sync_router()
    window = NavWindow(fail=True)
    router.ready(window, BASE)
    assert router.open("https://example.invalid/") is False
    assert router.open("finanse://signal/dom/1") is True  # run_js raises: logged, no crash
    assert window.calls == []
    assert "ignored a link" in caplog.text and "could not open a link" in caplog.text


def test_router_navigates_off_the_calling_thread():
    started = []
    router = notify.LinkRouter(spawn=lambda target, *args: started.append((target, args)))
    window = NavWindow()
    router.ready(window, BASE)
    router.open("finanse://signal/dom/9")
    assert window.calls == [] and len(started) == 1  # the Apple event thread never blocks
    target, args = started[0]
    target(*args)
    assert window.calls[0][0] == "js"


def test_default_spawn_runs_in_a_daemon_thread():
    done = threading.Event()
    seen = {}

    def work():
        seen["daemon"] = threading.current_thread().daemon
        done.set()

    notify._spawn(work)
    assert done.wait(5) and seen["daemon"] is True


# --------------------------------------------------------------------------- #
# The helper with a fake notification center
# --------------------------------------------------------------------------- #


class FakeCenter:
    def __init__(self, status="authorized", grant=(True, None), add=(True, None)):
        self.status = status
        self.grant = grant
        self.add_result = add
        self.calls: list[str] = []
        self.added: list[notify.NativeRequest] = []

    def authorization_status(self, timeout):
        self.calls.append("status")
        return self.status

    def request_authorization(self, timeout):
        self.calls.append("request")
        return self.grant

    def add(self, request, timeout):
        self.calls.append("add")
        self.added.append(request)
        return self.add_result


PAYLOAD = {
    "title": "Dom",
    "subtitle": "Sygnał do działania",
    "message": 'XMPL 37.3% > 30% "x" \n end',
    "group": "finanse-signal-7",
    "url": "finanse://signal/dom/7",
}


def request(**changes) -> notify.NativeRequest:
    return notify.NativeRequest.from_payload({**PAYLOAD, **changes})


def test_native_request_validation():
    req = request()
    assert (req.identifier, req.title, req.subtitle) == (
        "finanse-signal-7",
        "Dom",
        PAYLOAD["subtitle"],
    )
    assert req.message == 'XMPL 37.3% > 30% "x" end' and req.url == "finanse://signal/dom/7"
    assert request(url="https://evil.invalid/").url is None  # only links the app opens
    assert request(url=None, group=None).identifier.startswith("finanse-")
    assert request(subtitle=None).subtitle == ""
    assert len(request(message="x" * 5000).message) == 400
    for bad in ({"title": ""}, {"message": None}, {"title": 5}, {"group": "a b"}, {"group": 7}):
        with pytest.raises(TypeError):
            request(**bad)
    with pytest.raises(TypeError):
        notify.NativeRequest.from_payload(["not", "an", "object"])


@pytest.mark.parametrize(
    ("center", "expected", "calls"),
    [
        (FakeCenter(), ("delivered", None), ["status", "add"]),
        (FakeCenter("provisional"), ("delivered", None), ["status", "add"]),
        (FakeCenter("denied"), ("denied", None), ["status"]),
        (FakeCenter("not_determined"), ("delivered", None), ["status", "request", "add"]),
        (
            FakeCenter("not_determined", grant=(None, None)),
            ("pending", None),
            ["status", "request"],
        ),
        (
            FakeCenter("not_determined", grant=(False, None)),
            ("denied", None),
            ["status", "request"],
        ),
        (
            FakeCenter("not_determined", grant=(False, "UNErrorDomain 1: not allowed")),
            ("failed", "UNErrorDomain 1: not allowed"),
            ["status", "request"],
        ),
        (FakeCenter(None), ("failed", "the notification settings did not answer"), ["status"]),
        (FakeCenter(add=(False, "boom")), ("failed", "boom"), ["status", "add"]),
        (FakeCenter(add=(False, None)), ("failed", "posting failed"), ["status", "add"]),
    ],
    ids=[
        "authorized",
        "provisional",
        "denied",
        "first-use-granted",
        "first-use-no-answer",
        "first-use-refused",
        "first-use-error",
        "no-settings",
        "add-error",
        "add-silent",
    ],
)
def test_post_asks_for_permission_on_first_use_only(center, expected, calls):
    assert notify.post(center, request(), auth_wait=1, post_wait=1) == expected
    assert center.calls == calls


def helper(argv, stdin="", center=None, factory=None):
    out = io.StringIO()
    code = notify.helper_main(
        argv,
        stdin=io.StringIO(stdin),
        stdout=out,
        center_factory=factory or (lambda: center or FakeCenter()),
        auth_wait=1,
        post_wait=1,
    )
    return code, json.loads(out.getvalue().strip().splitlines()[-1])


def test_helper_posts_one_notification_from_stdin():
    center = FakeCenter()
    code, answer = helper([], json.dumps(PAYLOAD, ensure_ascii=False), center)
    assert (code, answer) == (na.EXIT_DELIVERED, {"status": "delivered"})
    (req,) = center.added
    assert req.identifier == "finanse-signal-7" and req.url == "finanse://signal/dom/7"


def test_helper_answers_with_matching_exit_codes():
    denied = helper([], json.dumps(PAYLOAD), FakeCenter("denied"))
    assert denied == (na.EXIT_DENIED, {"status": "denied"})
    pending = helper([], json.dumps(PAYLOAD), FakeCenter("not_determined", grant=(None, None)))
    assert pending == (na.EXIT_PENDING, {"status": "pending"})
    failed = helper([], json.dumps(PAYLOAD), FakeCenter(add=(False, "boom")))
    assert failed == (na.EXIT_FAILED, {"status": "failed", "error": "boom"})


def test_helper_rejects_bad_input_and_arguments():
    assert helper([], "{not json")[0] == na.EXIT_USAGE
    assert helper([], json.dumps({"title": "x"}))[1]["status"] == "usage"
    assert helper([], "x" * (notify.MAX_INPUT + 1))[1] == {
        "status": "usage",
        "error": "input too long",
    }
    assert helper(["--title", "x"])[0] == na.EXIT_USAGE


def test_helper_outside_the_app_is_unavailable_and_reports_crashes():
    def unavailable():
        raise notify.Unavailable("not running from Finanse.app")

    code, answer = helper([], json.dumps(PAYLOAD), factory=unavailable)
    assert (code, answer["status"]) == (na.EXIT_UNAVAILABLE, "unavailable")

    class Exploding(FakeCenter):
        def add(self, request, timeout):
            raise RuntimeError("objc.error: NSInternalInconsistencyException")

    code, answer = helper([], json.dumps(PAYLOAD), Exploding())
    assert code == na.EXIT_FAILED and "NSInternalInconsistencyException" in answer["error"]


def test_helper_status_asks_nothing():
    center = FakeCenter("not_determined")
    code, answer = helper(["--status"], center=center)
    assert code == 0 and answer["authorization"] == "not_determined"
    assert center.calls == ["status"]  # no permission prompt, nothing posted


def test_native_center_refuses_outside_the_app_bundle():
    assert runtime.app_bundle() is None
    with pytest.raises(notify.Unavailable):
        notify.NativeCenter()  # never touches UserNotifications from a plain interpreter


def test_worker_and_helper_speak_the_same_protocol(tmp_path):
    """AppNotifier -> (stdin JSON) -> helper_main -> fake center, end to end in-process."""
    from test_worker_notifier_app import make_app

    from finanse.core.worker.notifier import CommandResult

    center = FakeCenter()

    def run_helper(args, data):
        assert args[-1] == na.HELPER_ARG == entry.NOTIFY_HELPER
        out = io.StringIO()
        code = notify.helper_main(
            args[2:], stdin=io.StringIO(data), stdout=out, center_factory=lambda: center
        )
        return CommandResult(code, out.getvalue())

    app = na.AppNotifier(na.inspect_bundle(make_app(tmp_path)), runner=run_helper)
    note = Notification(
        title="finanse: Dom",
        subtitle="Sygnał do działania",
        message="XMPL 37.3% > 30%",
        group="finanse-signal-7",
        url=signal_link("dom", 7),
    )
    assert app.send(note).ok
    (req,) = center.added
    assert (req.title, req.subtitle, req.message) == (
        "Dom",
        "Sygnał do działania",
        "XMPL 37.3% > 30%",
    )
    assert notify.link_to_hash(req.url) == "#/dom/investments.portfolio/?signal=7"

    center.status = "denied"
    assert app.send(note).error == na.DENIED_HINT


def test_box_waits_for_a_handler_on_another_thread():
    box = notify._Box(pump=lambda s: None)
    threading.Timer(0.05, box.put, args=("answer",)).start()
    assert box.wait(5) == "answer"
    pumped = []
    assert notify._Box(pump=pumped.append).wait(0.12) is notify._TIMEOUT
    assert pumped and all(s <= 0.05 for s in pumped)


def test_entry_dispatches_the_helper_without_the_cli(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "finanse.cli", None)  # the CLI must not be imported
    with pytest.raises(SystemExit) as done:
        entry.main(["--notify-helper", "--status"])
    assert done.value.code == na.EXIT_UNAVAILABLE  # a plain interpreter is not Finanse.app
    assert json.loads(capsys.readouterr().out)["status"] == "unavailable"


# --------------------------------------------------------------------------- #
# App handlers (no OS registration in tests)
# --------------------------------------------------------------------------- #


def test_install_app_handlers_does_nothing_outside_the_app(monkeypatch):
    monkeypatch.setattr(notify, "_on_link", None)
    monkeypatch.setattr(notify, "_install_url_handler", lambda: pytest.fail("registered"))
    assert notify.install_app_handlers(lambda url: None) is False
    assert notify._on_link is None


def test_install_app_handlers_inside_the_app(monkeypatch, tmp_path, caplog):
    if sys.platform != "darwin":
        pytest.skip("macOS only")
    monkeypatch.setattr(runtime, "app_bundle", lambda: tmp_path / "Finanse.app")
    steps = []

    def broken():
        raise RuntimeError("no AppKit")

    monkeypatch.setattr(notify, "_install_url_handler", broken)
    monkeypatch.setattr(notify, "_install_notification_delegate", lambda: steps.append("delegate"))
    monkeypatch.setattr(notify, "_on_link", None)
    got = []
    assert notify.install_app_handlers(got.append) is True
    assert steps == ["delegate"] and "could not install the URL handler" in caplog.text
    notify.dispatch_link("finanse://open")
    notify.dispatch_link(None)
    assert got == ["finanse://open"]


def test_dispatch_link_never_raises(monkeypatch, caplog):
    def boom(url):
        raise ValueError("bad")

    monkeypatch.setattr(notify, "_on_link", boom)
    notify.dispatch_link("finanse://open")
    assert "link handler failed" in caplog.text


# --------------------------------------------------------------------------- #
# The ObjC callbacks through the bridge (fake objects, nothing registered)
# --------------------------------------------------------------------------- #


@pytest.fixture
def objc_classes(monkeypatch):
    pytest.importorskip("UserNotifications")
    got: list[str] = []
    monkeypatch.setattr(notify, "_on_link", got.append)
    handler_cls, delegate_cls = notify._objc_classes()
    return handler_cls, delegate_cls, got


def fake_response(action, user_info):
    class Content:
        def userInfo(self):
            return user_info

    class Request:
        def content(self):
            return Content()

    class Note:
        def request(self):
            return Request()

    class Response:
        def actionIdentifier(self):
            return action

        def notification(self):
            return Note()

    return Response()


def test_a_click_on_a_notification_opens_its_link(objc_classes):
    import UserNotifications as un

    _, delegate_cls, got = objc_classes
    delegate = delegate_cls.alloc().init()
    completed = []
    click = fake_response(
        un.UNNotificationDefaultActionIdentifier, {"url": "finanse://signal/dom/7"}
    )
    delegate.userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(
        None, click, lambda: completed.append(1)
    )
    dismiss = fake_response(un.UNNotificationDismissActionIdentifier, {"url": "finanse://open"})
    delegate.userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(
        None, dismiss, lambda: completed.append(2)
    )
    assert got == ["finanse://signal/dom/7"] and completed == [1, 2]


def test_a_broken_click_still_completes(objc_classes, caplog):
    _, delegate_cls, got = objc_classes
    delegate = delegate_cls.alloc().init()
    completed = []

    class Broken:
        def actionIdentifier(self):
            raise RuntimeError("gone")

    delegate.userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(
        None, Broken(), lambda: completed.append(1)
    )
    assert got == [] and completed == [1] and "could not read" in caplog.text


def test_notifications_show_while_the_app_is_in_front(objc_classes):
    _, delegate_cls, _ = objc_classes
    options = []
    delegate_cls.alloc().init().userNotificationCenter_willPresentNotification_withCompletionHandler_(
        None, None, options.append
    )
    assert options == [notify.PRESENT_OPTIONS] == [16 | 8 | 2]  # banner, list, sound


def test_url_apple_event_opens_the_link(objc_classes):
    handler_cls, _, got = objc_classes
    keys = []

    class Descriptor:
        def stringValue(self):
            return "finanse://review/dom"

    class Event:
        def paramDescriptorForKeyword_(self, key):
            keys.append(key)
            return Descriptor()

    handler_cls.alloc().init().handleGetURLEvent_withReplyEvent_(Event(), None)
    assert got == ["finanse://review/dom"] and keys == [int.from_bytes(b"----", "big")]
    assert notify.K_AE_GET_URL == notify.K_INTERNET_EVENT_CLASS == 0x4755524C  # 'GURL'


# --------------------------------------------------------------------------- #
# Desktop shell wiring
# --------------------------------------------------------------------------- #


class LinkWindow(FakeWindow):
    def get_current_url(self):
        return self.loaded[-1][1] if self.loaded and self.loaded[-1][0] == "url" else None

    def run_js(self, script):
        self.loaded.append(("js", script))

    def show(self):
        self.loaded.append(("show", ""))


class LinkWebview(FakeWebview):
    """A link arrives before the boot function runs (a click that launched the app) and another
    one after the window has loaded the dashboard (the app was already open)."""

    def __init__(self, links_before, links_after):
        super().__init__()
        self.before, self.after = links_before, links_after
        self.on_link = None

    def create_window(self, title, **kwargs):
        self.window = LinkWindow(title=title, **kwargs)
        return self.window

    def start(self, func, args, **kwargs):
        for url in self.before:
            self.on_link(url)
        func(*args)
        for url in self.after:
            self.on_link(url)


@pytest.fixture
def app_data(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("FINANSE_DATA_DIR", str(path))
    monkeypatch.setattr(security, "_config", security._config)  # shell.run() configures it
    return path


def test_shell_opens_the_window_on_a_link_and_follows_later_links(app_data, monkeypatch):
    _patch_server_app(monkeypatch)
    fake = LinkWebview(["finanse://signal/dom/5"], ["finanse://review/dom"])

    def install(on_link):
        fake.on_link = on_link
        return True

    monkeypatch.setattr(notify, "install_app_handlers", install)
    monkeypatch.setattr(notify, "_spawn", lambda target, *args: target(*args))
    launch = shell.run(webview_module=fake)
    base = f"http://127.0.0.1:{launch.port}/"
    assert fake.window.loaded == [
        ("url", base + "#/dom/investments.portfolio/?signal=5"),
        ("js", 'location.hash = "#/dom/investments.portfolio/?review=1";'),
        ("show", ""),
    ]


def test_shell_without_links_loads_the_plain_url(app_data, monkeypatch):
    _patch_server_app(monkeypatch)
    installed = []
    monkeypatch.setattr(notify, "install_app_handlers", lambda cb: installed.append(cb) or False)
    fake = FakeWebview()
    launch = shell.run(webview_module=fake)
    assert fake.window.loaded == [("url", f"http://127.0.0.1:{launch.port}/")]
    assert len(installed) == 1  # asked once per launch (a no-op outside Finanse.app)
