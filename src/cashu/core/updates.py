"""App update check: compares the running version with the one on a GitHub branch.

The source of truth is the ``version`` field of ``pyproject.toml`` on the configured branch
(``CASHU_UPDATE_REPO`` / ``CASHU_UPDATE_BRANCH``, default ``Utopia-USS/cashu`` / ``main``),
read as a raw file. Nothing about the user is sent: one anonymous GET of a public file. The app
never downloads or installs anything; the dashboard only shows a notice with a link to the
branch's commits. ``CASHU_UPDATE_CHECK=0`` turns the check off.

A successful result is cached in memory for ``CACHE_TTL`` so reloads of the dashboard do not hit
GitHub again (a failure is not cached: the next request retries); a new process (the next app
launch) checks afresh.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import threading
import tomllib
from dataclasses import asdict, dataclass

from .. import __version__

log = logging.getLogger("cashu.updates")

CACHE_TTL = dt.timedelta(hours=6)
TIMEOUT_S = 5.0

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_BRANCH_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_./-]*$")
_VERSION_RE = re.compile(r"^\s*v?(\d+(?:\.\d+)*)(.*)$")


@dataclass(frozen=True)
class UpdateStatus:
    current: str
    latest: str | None
    available: bool
    # The branch's commit list on GitHub (what changed); None when the check is off or misconfigured.
    url: str | None
    checked_at: str
    # None when the check succeeded; else "disabled" | "config" | "network" | "parse".
    error: str | None = None

    def to_json(self) -> dict:
        return asdict(self)


def parse_version(raw: str) -> tuple[tuple[int, ...], bool] | None:
    """``"0.2.0"`` -> ``((0, 2, 0), False)``; a suffix (``0.2.0rc1``, ``0.2.0-dev``) marks a
    pre-release: ``((0, 2, 0), True)``. None when there is no leading number."""
    m = _VERSION_RE.match(raw)
    if not m:
        return None
    nums = tuple(int(p) for p in m.group(1).split("."))
    while len(nums) > 1 and nums[-1] == 0:
        nums = nums[:-1]
    return nums, bool(m.group(2).strip())


def is_newer(latest: str, current: str) -> bool:
    """True when ``latest`` is a higher version than ``current``. A release beats a pre-release of
    the same number; two pre-releases of one number are never "newer" (no false alarms)."""
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    if a[0] != b[0]:
        return a[0] > b[0]
    return b[1] and not a[1]


def raw_url(repo: str, branch: str) -> str:
    return f"https://raw.githubusercontent.com/{repo}/{branch}/pyproject.toml"


def commits_url(repo: str, branch: str) -> str:
    return f"https://github.com/{repo}/commits/{branch}"


def fetch_remote_version(repo: str, branch: str) -> str:
    """The ``project.version`` of ``pyproject.toml`` on ``repo@branch``. Raises httpx errors on
    network failures and ``ValueError`` when the file is not TOML or has no usable version."""
    import httpx

    r = httpx.get(raw_url(repo, branch), timeout=TIMEOUT_S, follow_redirects=True,
                  headers={"User-Agent": f"cashu/{__version__}"})
    r.raise_for_status()
    version = tomllib.loads(r.text).get("project", {}).get("version")
    if not isinstance(version, str) or parse_version(version) is None:
        raise ValueError("pyproject.toml has no project.version")
    return version


_lock = threading.Lock()
_cache: tuple[dt.datetime, tuple[str, str], UpdateStatus] | None = None


def check() -> UpdateStatus:
    """The update status (a success is cached for ``CACHE_TTL`` per repo/branch). Never raises: a
    failure is reported in ``error`` and the notice simply stays hidden."""
    global _cache
    from ..config import settings

    now = dt.datetime.now(dt.UTC)
    stamp = now.isoformat()
    if not settings.update_check:
        return UpdateStatus(__version__, None, False, None, stamp, "disabled")
    repo, branch = settings.update_repo.strip(), settings.update_branch.strip()
    if not _REPO_RE.match(repo) or not _BRANCH_RE.match(branch) or ".." in branch:
        log.warning("Update check: invalid CASHU_UPDATE_REPO / CASHU_UPDATE_BRANCH")
        return UpdateStatus(__version__, None, False, None, stamp, "config")

    key = (repo, branch)
    with _lock:
        if _cache and _cache[1] == key and now - _cache[0] < CACHE_TTL:
            return _cache[2]

    import httpx

    url = commits_url(repo, branch)
    try:
        latest = fetch_remote_version(repo, branch)
    except ValueError:  # no / unusable version, TOML syntax (TOMLDecodeError is a ValueError)
        log.warning("Update check: no version in %s", raw_url(repo, branch))
        status = UpdateStatus(__version__, None, False, url, stamp, "parse")
    except httpx.HTTPError as e:  # network, timeout, HTTP status: "unknown right now"
        log.info("Update check failed: %s", type(e).__name__)
        status = UpdateStatus(__version__, None, False, url, stamp, "network")
    else:
        status = UpdateStatus(__version__, latest, is_newer(latest, __version__), url, stamp)
        with _lock:
            _cache = (now, key, status)
    return status


def reset_cache() -> None:
    """Forget the cached result (tests)."""
    global _cache
    with _lock:
        _cache = None
