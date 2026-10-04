"""Shared HTTP access for market data sources: timeout, retries with backoff, per-host pacing."""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable, Mapping

import httpx

from .sources import SourceBlockedException, SourceException

Sleep = Callable[[float], None]
"""Waits for the given number of seconds. Injectable so tests run without real delays."""

Clock = Callable[[], float]
"""Monotonic time in seconds (``time.monotonic`` by default)."""

Backoff = Callable[[int], float]
"""Delay in seconds before retry number ``n`` (1 for the first retry)."""


def exponential_backoff(retry: int) -> float:
    """Default backoff: 1 s, 2 s, 4 s..."""
    return float(1 << (retry - 1))


class MarketHttp:
    """GETs for market data sources over an injected ``httpx.Client``.

    Share one instance between all sources of a run so the per-host gap holds across them.

    - Each attempt is limited to ``timeout`` seconds (connect + full response).
    - Retried: HTTP 429, HTTP 5xx, network errors and timeouts (``httpx.TransportError``), at most
      ``max_retries`` times after the first attempt, waiting ``backoff(n)``. A 429 ``Retry-After`` header
      (seconds, capped at ``max_retry_after``) lengthens the wait.
    - Exhausted retries raise a retryable :class:`SourceException` (:class:`SourceBlockedException` for
      a persistent 429).
    - Every other response (2xx, 3xx, 4xx except 429) is returned as is; the source interprets it (NBP
      answers 404 for "no data in range", Yahoo 404 for an unknown symbol).
    - Requests to one host start at least ``min_host_interval`` seconds apart.
    """

    def __init__(
        self,
        client: httpx.Client,
        *,
        timeout: float = 15.0,
        max_retries: int = 2,
        min_host_interval: float = 0.3,
        max_retry_after: float = 30.0,
        backoff: Backoff = exponential_backoff,
        sleep: Sleep = time.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self._client = client
        self.timeout = timeout
        self.max_retries = max_retries
        self.min_host_interval = min_host_interval
        self.max_retry_after = max_retry_after
        self._backoff = backoff
        self._sleep = sleep
        self._clock = clock
        self._next_slot: dict[str, float] = {}
        self._lock = threading.Lock()

    def get(
        self,
        url: str,
        *,
        source_id: str,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """GETs ``url`` on behalf of source ``source_id`` (named in raised exceptions)."""
        host = httpx.URL(url).host
        attempts = self.max_retries + 1
        attempt = 0
        while True:
            attempt += 1
            is_last = attempt == attempts
            self._wait_for_slot(host)
            try:
                response = self._client.get(
                    url, params=params, headers=headers, timeout=self.timeout
                )
            except httpx.TransportError as error:
                if is_last:
                    if isinstance(error, httpx.TimeoutException):
                        what = f"timed out after {int(self.timeout * 1000)} ms"
                    else:
                        what = f"network error: {error}"
                    raise SourceException(
                        source_id,
                        f"{host} {what} ({attempts} attempts)",
                        retryable=True,
                        cause=error,
                    ) from error
                self._sleep(self._backoff(attempt))
                continue
            if not _is_retryable_status(response.status_code):
                return response
            if is_last:
                raise _exhausted(source_id, host, response, attempts)
            self._sleep(self._retry_delay(attempt, response))

    def _wait_for_slot(self, host: str) -> None:
        with self._lock:
            now = self._clock()
            reserved = self._next_slot.get(host)
            start = reserved if reserved is not None and reserved > now else now
            self._next_slot[host] = start + self.min_host_interval
        if start > now:
            self._sleep(start - now)

    def _retry_delay(self, retry: int, response: httpx.Response) -> float:
        base = self._backoff(retry)
        if response.status_code != 429:
            return base
        try:
            retry_after = int(response.headers.get("retry-after", "").strip())
        except ValueError:
            return base
        if retry_after <= 0:
            return base
        return max(min(float(retry_after), self.max_retry_after), base)


def _is_retryable_status(status: int) -> bool:
    return status == 429 or 500 <= status <= 599


def _exhausted(
    source_id: str, host: str, response: httpx.Response, attempts: int
) -> SourceException:
    status = response.status_code
    message = f"{host} answered HTTP {status} ({attempts} attempts)"
    if status == 429:
        return SourceBlockedException(source_id, f"rate limited: {message}", retryable=True)
    return SourceException(source_id, message, retryable=True)


_WHITESPACE = re.compile(r"\s+")


def body_snippet(body: str, max_chars: int = 120) -> str:
    """The first ``max_chars`` characters of ``body`` on one line, for error messages."""
    return _WHITESPACE.sub(" ", body).strip()[:max_chars]
