"""Environment variables of cashU (``CASHU_*``), with the pre-rename names as a fallback.

The app was called finanse before 0.2 and read ``FINANSE_*`` variables. Every reader goes through
:func:`env`, which checks ``CASHU_X`` first and then the legacy ``FINANSE_X`` (logging a one-time
deprecation note at debug level), so an old ``.env``, launchd plist or ``.mcp.json`` keeps working
until it is rewritten. New code, tests and docs use the ``CASHU_`` names only.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

PREFIX = "CASHU_"
LEGACY_PREFIX = "FINANSE_"  # legacy name (before the rename to cashU)

log = logging.getLogger(__name__)
_warned: set[str] = set()


def name(key: str) -> str:
    """``"DATA_DIR"`` or ``"CASHU_DATA_DIR"`` -> ``"CASHU_DATA_DIR"``."""
    return key if key.startswith(PREFIX) else PREFIX + key


def legacy_name(key: str) -> str:
    """The pre-rename variable of ``key``: ``"CASHU_DATA_DIR"`` -> ``"FINANSE_DATA_DIR"``."""
    return LEGACY_PREFIX + name(key).removeprefix(PREFIX)


def names(key: str) -> list[str]:
    """``[CASHU_X, FINANSE_X]``: for readers that take a list (typer ``envvar``)."""
    return [name(key), legacy_name(key)]


def env(key: str, default: str | None = None, environ: Mapping[str, str] | None = None) -> str | None:
    """The value of ``CASHU_<key>``, else of the legacy ``FINANSE_<key>``, else ``default``. An empty
    new variable counts as set (it overrides the legacy one), as with a plain ``os.environ.get``."""
    source = os.environ if environ is None else environ
    new = name(key)
    if new in source:
        return source[new]
    old = legacy_name(key)
    if old in source:
        if old not in _warned:
            _warned.add(old)
            log.debug("%s is deprecated, use %s", old, new)
        return source[old]
    return default


def is_set(key: str, environ: Mapping[str, str] | None = None) -> bool:
    return env(key, None, environ) is not None
