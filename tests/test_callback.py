import threading
import time

import httpx

from cashu.modules.budget.ingestion.enable_banking.callback import wait_for_authorization_code


def _capture_via(redirect: str, verify):
    result: dict[str, str | None] = {}

    def run():
        result["code"] = wait_for_authorization_code(redirect, timeout=10)

    t = threading.Thread(target=run)
    t.start()

    status = None
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            r = httpx.get(f"{redirect}?code=TESTCODE&state=cashu", timeout=1, verify=verify)
            status = r.status_code
            break
        except httpx.HTTPError:
            time.sleep(0.1)

    t.join(timeout=5)
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
