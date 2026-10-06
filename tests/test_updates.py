"""App update check (core/updates.py) and GET /api/system/update. No network: the fetch of the
remote pyproject.toml is replaced by a fake (httpx.MockTransport or a monkeypatched function)."""

from __future__ import annotations

import tomllib

import httpx
import pytest

from cashu import __version__
from cashu.config import settings
from cashu.core import paths, updates


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    updates.reset_cache()
    monkeypatch.setattr(settings, "update_check", True)
    monkeypatch.setattr(settings, "update_repo", "owner/cashu")
    monkeypatch.setattr(settings, "update_branch", "main")
    yield
    updates.reset_cache()


def fake_remote(monkeypatch, version: str | Exception, calls: list | None = None):
    def fetch(repo, branch):
        if calls is not None:
            calls.append((repo, branch))
        if isinstance(version, Exception):
            raise version
        return version

    monkeypatch.setattr(updates, "fetch_remote_version", fetch)


def test_package_version_matches_pyproject():
    """The check compares __version__ with pyproject.toml on GitHub, so the two must agree here."""
    data = tomllib.loads((paths.PROJECT_ROOT / "pyproject.toml").read_text())
    assert data["project"]["version"] == __version__


@pytest.mark.parametrize(
    ("latest", "current", "newer"),
    [
        ("0.2.0", "0.1.0", True),
        ("0.1.1", "0.1.0", True),
        ("1.0", "0.9.9", True),
        ("0.10.0", "0.9.0", True),
        ("0.1.0", "0.1.0", False),
        ("0.1", "0.1.0", False),
        ("0.1.0", "0.2.0", False),
        ("0.2.0", "0.2.0rc1", True),
        ("0.2.0", "0.2.0-dev", True),
        ("0.2.0rc2", "0.2.0rc1", False),
        ("0.2.0rc1", "0.2.0", False),
        ("v0.3.0", "0.2.0", True),
        ("garbage", "0.1.0", False),
    ],
)
def test_is_newer(latest, current, newer):
    assert updates.is_newer(latest, current) is newer


def test_newer_remote_version_is_available(monkeypatch):
    fake_remote(monkeypatch, "99.0.0")
    status = updates.check()
    assert status.available is True
    assert status.latest == "99.0.0"
    assert status.current == __version__
    assert status.url == "https://github.com/owner/cashu/commits/main"
    assert status.error is None


def test_same_version_is_not_available(monkeypatch):
    fake_remote(monkeypatch, __version__)
    status = updates.check()
    assert (status.available, status.latest, status.error) == (False, __version__, None)


def test_success_is_cached_failure_is_not(monkeypatch):
    calls: list = []
    fake_remote(monkeypatch, httpx.ConnectError("offline"), calls)
    assert updates.check().error == "network"
    fake_remote(monkeypatch, "99.0.0", calls)
    assert updates.check().available is True
    assert updates.check().available is True
    assert len(calls) == 2  # the failure was retried, the success was served from the cache


def test_cache_is_per_repo_and_branch(monkeypatch):
    calls: list = []
    fake_remote(monkeypatch, "99.0.0", calls)
    updates.check()
    monkeypatch.setattr(settings, "update_branch", "dev")
    updates.check()
    assert calls == [("owner/cashu", "main"), ("owner/cashu", "dev")]


def test_disabled_check_never_fetches(monkeypatch):
    calls: list = []
    fake_remote(monkeypatch, "99.0.0", calls)
    monkeypatch.setattr(settings, "update_check", False)
    status = updates.check()
    assert (status.available, status.error, status.url) == (False, "disabled", None)
    assert calls == []


@pytest.mark.parametrize(
    ("repo", "branch"),
    [("owner", "main"), ("owner/cashu/extra", "main"), ("owner/cashu", "../x"),
     ("owner/fi nanse", "main"), ("owner/cashu", "-x"), ("owner/cashu", "a?b")],
)
def test_invalid_source_is_rejected(monkeypatch, repo, branch):
    calls: list = []
    fake_remote(monkeypatch, "99.0.0", calls)
    monkeypatch.setattr(settings, "update_repo", repo)
    monkeypatch.setattr(settings, "update_branch", branch)
    assert updates.check().error == "config"
    assert calls == []


def _mock_httpx(monkeypatch, handler):
    """httpx.get answered by ``handler`` (httpx.MockTransport), with the caller's headers/timeout."""

    def get(url, *, headers=None, timeout=None, **_):
        with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as c:
            return c.get(url, headers=headers, timeout=timeout)

    monkeypatch.setattr(httpx, "get", get)


def test_fetch_reads_project_version_from_raw_pyproject(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, text='[project]\nname = "cashu"\nversion = "0.4.2"\n')

    _mock_httpx(monkeypatch, handler)
    assert updates.fetch_remote_version("owner/cashu", "main") == "0.4.2"
    assert seen == ["https://raw.githubusercontent.com/owner/cashu/main/pyproject.toml"]


@pytest.mark.parametrize(
    ("status_code", "body", "error"),
    [
        (404, "Not Found", "network"),
        (200, "not = [toml", "parse"),
        (200, "[project]\nname = 'x'\n", "parse"),
    ],
)
def test_fetch_failures_map_to_error_codes(monkeypatch, status_code, body, error):
    _mock_httpx(monkeypatch, lambda request: httpx.Response(status_code, text=body))
    status = updates.check()
    assert (status.available, status.latest, status.error) == (False, None, error)


def test_update_endpoint(api_empty, monkeypatch):
    fake_remote(monkeypatch, "99.0.0")
    body = api_empty.get("/api/system/update").json()
    assert set(body) == {"current", "latest", "available", "url", "checked_at", "error"}
    assert body["available"] is True
    assert body["latest"] == "99.0.0"
    assert body["current"] == __version__
