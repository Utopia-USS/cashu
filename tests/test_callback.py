import os
import sys
import threading
import time

import httpx
import pytest

from cashu.modules.budget.ingestion.enable_banking.callback import wait_for_authorization_code

# GitHub's macOS runners drop connections to a local listener (ConnectTimeout even on
# 127.0.0.1); the tests pass on a real Mac and on the Linux runners.
pytestmark = pytest.mark.skipif(
    sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true",
    reason="local listeners are unreachable on GitHub macOS runners",
)


def _capture_via(redirect: str, verify):
    result: dict[str, str | None] = {}

    def run():
        result["code"] = wait_for_authorization_code(redirect, timeout=10)

    t = threading.Thread(target=run)
    t.start()

    status = None
    last_error: Exception | None = None
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            # IPv4 explicitly: the listener binds localhost's IPv4 address, and some hosts resolve
            # localhost to ::1 first
            url = redirect.replace("//localhost:", "//127.0.0.1:")
            # trust_env=False: a system proxy (macOS reads it from the OS settings) must not
            # carry a request to localhost
            r = httpx.get(
                f"{url}?code=TESTCODE&state=cashu", timeout=1, verify=verify, trust_env=False
            )
            status = r.status_code
            break
        except httpx.HTTPError as exc:
            last_error = exc
            time.sleep(0.1)

    t.join(timeout=5)
    assert status is not None, f"no answer from the listener: {last_error!r}"
    return status, result.get("code")


def test_callback_captures_code_http():
    status, code = _capture_via("http://localhost:8799/eb/callback", verify=True)
    assert status == 200
    assert code == "TESTCODE"


def test_callback_captures_code_https():
    # self-signed cert -> disable verification on the client side
    status, code = _capture_via("https://localhost:8798/eb/callback", verify=False)
    assert status == 200
    assert code == "TESTCODE"
