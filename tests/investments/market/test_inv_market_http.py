"""MarketHttp: retries, backoff, Retry-After, timeouts, per-host pacing (port of market_http_test.dart)."""

from __future__ import annotations

import httpx
import pytest
from inv_market_support import FakeTime, make_http

from finanse.modules.investments.market import (
    MarketHttp,
    SourceBlockedException,
    SourceException,
    exponential_backoff,
)

URL = "https://api.example.test/data"


def scripted(time: FakeTime, outcomes: list, headers: dict[str, str] | None = None):
    """A client answering with the next outcome (a status code or an exception to raise; the last one
    repeats), recording request start times."""
    starts: list[float] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        starts.append(time.now)
        outcome = outcomes[min(calls["n"], len(outcomes) - 1)]
        calls["n"] += 1
        if isinstance(outcome, type) and issubclass(outcome, Exception):
            raise outcome("scripted failure", request=request)
        if isinstance(outcome, Exception):
            raise outcome
        return httpx.Response(outcome, text=f"body {outcome}", headers=headers or {})

    return httpx.Client(transport=httpx.MockTransport(handler)), starts


def test_a_2xx_answer_is_returned_after_one_request():
    time = FakeTime()
    client, starts = scripted(time, [200])
    assert make_http(client, time).get(URL, source_id="test").status_code == 200
    assert len(starts) == 1
    assert time.sleeps == []


def test_a_non_retryable_status_is_returned_without_retrying():
    time = FakeTime()
    client, starts = scripted(time, [404])
    assert make_http(client, time).get(URL, source_id="test").status_code == 404
    assert len(starts) == 1


def test_5xx_is_retried_twice_with_exponential_backoff_then_succeeds():
    time = FakeTime()
    client, starts = scripted(time, [503, 502, 200])
    assert make_http(client, time).get(URL, source_id="test").status_code == 200
    assert len(starts) == 3
    assert time.sleeps == [1.0, 2.0]


def test_persistent_5xx_raises_a_retryable_source_exception_after_3_attempts():
    time = FakeTime()
    client, starts = scripted(time, [500])
    with pytest.raises(SourceException) as caught:
        make_http(client, time).get(URL, source_id="test")
    error = caught.value
    assert len(starts) == 3
    assert not isinstance(error, SourceBlockedException)
    assert error.retryable is True
    assert error.source_id == "test"
    assert "HTTP 500" in error.message
    assert "3 attempts" in error.message


def test_persistent_429_raises_blocked_and_retry_after_lengthens_the_wait():
    time = FakeTime()
    client, starts = scripted(time, [429], headers={"retry-after": "5"})
    with pytest.raises(SourceBlockedException) as caught:
        make_http(client, time).get(URL, source_id="yahoo")
    assert caught.value.retryable is True
    assert "rate limited" in caught.value.message
    assert len(starts) == 3
    assert time.sleeps == [5.0, 5.0]


def test_retry_after_is_capped_at_max_retry_after():
    time = FakeTime()
    client, _ = scripted(time, [429, 200], headers={"retry-after": "3600"})
    make_http(client, time).get(URL, source_id="yahoo")
    assert time.sleeps == [30.0]


def test_network_errors_are_retried_and_a_later_success_wins():
    time = FakeTime()
    client, starts = scripted(time, [httpx.ConnectError, httpx.RemoteProtocolError, 200])
    assert make_http(client, time).get(URL, source_id="test").status_code == 200
    assert len(starts) == 3


def test_persistent_network_errors_raise_a_retryable_source_exception_with_the_cause():
    time = FakeTime()
    client, starts = scripted(time, [httpx.ConnectError])
    with pytest.raises(SourceException) as caught:
        make_http(client, time).get(URL, source_id="nbp")
    assert len(starts) == 3
    assert caught.value.retryable is True
    assert "network error: scripted failure" in caught.value.message
    assert isinstance(caught.value.cause, httpx.ConnectError)


def test_a_timeout_is_retried_then_fails_as_retryable():
    time = FakeTime()
    client, starts = scripted(time, [httpx.ReadTimeout])
    with pytest.raises(SourceException) as caught:
        make_http(client, time, timeout=0.02).get(URL, source_id="test")
    assert len(starts) == 3
    assert caught.value.retryable is True
    assert "timed out after 20 ms" in caught.value.message
    assert isinstance(caught.value.cause, httpx.TimeoutException)


def test_the_timeout_is_passed_to_every_request():
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions.get("timeout"))
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    make_http(client, timeout=7.5).get(URL, source_id="test")
    assert seen[0] == {"connect": 7.5, "read": 7.5, "write": 7.5, "pool": 7.5}


def test_requests_to_one_host_start_at_least_300_ms_apart_other_hosts_not_delayed():
    time = FakeTime()
    starts: dict[str, list[float]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        starts.setdefault(request.url.host, []).append(time.now)
        return httpx.Response(200, text="ok")

    market = make_http(httpx.Client(transport=httpx.MockTransport(handler)), time)
    market.get(URL, source_id="a")
    market.get("https://other.example.test/", source_id="b")
    market.get(URL, source_id="a")
    market.get(URL, source_id="a")

    same = starts["api.example.test"]
    assert len(same) == 3
    assert all(same[i] - same[i - 1] >= 0.3 - 1e-9 for i in range(1, len(same)))
    assert starts["other.example.test"] == [1000.0]

    # A host idle for longer than the gap is not delayed.
    time.sleeps.clear()
    time.now += 5
    market.get(URL, source_id="a")
    assert time.sleeps == []


def test_slots_are_reserved_so_callers_queue_up_per_host():
    sleeps: list[float] = []
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    # Time stands still while three calls reserve their slots.
    market = MarketHttp(client, clock=lambda: 50.0, sleep=sleeps.append)
    for _ in range(3):
        market.get(URL, source_id="a")
    assert sleeps == pytest.approx([0.3, 0.6])


def test_default_backoff_doubles():
    assert [exponential_backoff(n) for n in (1, 2, 3)] == [1.0, 2.0, 4.0]
