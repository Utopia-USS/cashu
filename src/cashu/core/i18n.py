"""UI language of the texts the backend renders (docs/agents/localization.md).

The dashboard sends its language on every request as ``X-Cashu-Lang``; :class:`LanguageMiddleware`
makes it the current language for that request and remembers it as the app language
(``<data dir>/settings.json``), which work outside a request (the background worker, notifications)
uses. Without a stored choice the app language is the OS language when it is supported, else English;
``CASHU_LANG`` overrides both (the test suite pins Polish, so existing assertions keep their text).

Texts are written next to each other: ``tr(pl="Wydatki", en="Expenses")``. Agent content and Polish
matching data are not localized. MCP output is for the agent and stays as it is.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from typing import Literal, cast

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from . import paths

Lang = Literal["pl", "en"]
LANGS: tuple[Lang, ...] = ("pl", "en")  # keep in sync with frontend/src/i18n.ts
FALLBACK_LANG: Lang = "en"
LANG_HEADER = "x-cashu-lang"
LANG_ENV = "CASHU_LANG"
SETTINGS_FILE = "settings.json"

_current: ContextVar[Lang | None] = ContextVar("cashu_lang", default=None)


def parse_lang(value: object) -> Lang | None:
    """``"en"``, ``"en-GB"``, ``"pl_PL.UTF-8"`` -> the supported language, else None."""
    if not isinstance(value, str):
        return None
    base = value.strip().lower().replace("_", "-").split("-")[0].split(".")[0]
    return cast(Lang, base) if base in LANGS else None


# --------------------------------------------------------------------------- #
# App language (outside a request)
# --------------------------------------------------------------------------- #


def settings_path():
    return paths.data_dir() / SETTINGS_FILE


def _read_settings() -> dict:
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_settings(data: dict) -> None:
    path = settings_path()
    paths.ensure_private_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


@lru_cache(maxsize=1)
def os_language() -> Lang | None:
    """The first supported language of the OS preference list (macOS ``AppleLanguages``, else the
    locale environment), or None. A launchd agent has no LANG, hence the macOS lookup first."""
    if sys.platform == "darwin":
        try:
            out = subprocess.run(
                ["defaults", "read", "-g", "AppleLanguages"],
                capture_output=True, text=True, timeout=2, check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        for token in out.replace("(", " ").replace(")", " ").replace(",", " ").split():
            lang = parse_lang(token.strip('"'))
            if lang:
                return lang
    for var in ("LC_ALL", "LC_MESSAGES", "LANG"):
        if os.environ.get(var):
            return parse_lang(os.environ[var])
    return None


def app_language() -> Lang:
    """``CASHU_LANG`` when set (tests pin ``pl``), else the language the dashboard last used, else the
    OS language, else English."""
    return (
        parse_lang(os.environ.get(LANG_ENV))
        or parse_lang(_read_settings().get("language"))
        or os_language()
        or FALLBACK_LANG
    )


_remembered: tuple[str, Lang] | None = None


def remember_app_language(lang: Lang) -> None:
    """Store the dashboard's language for the worker; writes only when it changes. Never raises."""
    global _remembered
    key = (str(settings_path()), lang)
    if key == _remembered:
        return
    try:
        data = _read_settings()
        if data.get("language") != lang:
            data["language"] = lang
            _write_settings(data)
        _remembered = key
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Current language and texts
# --------------------------------------------------------------------------- #


def lang() -> Lang:
    """The language of this request (``X-Cashu-Lang``), else the app language."""
    return _current.get() or app_language()


@contextmanager
def use_language(value: Lang) -> Iterator[None]:
    """Render texts in ``value`` inside the block (tests, the worker)."""
    token = _current.set(value)
    try:
        yield
    finally:
        _current.reset(token)


def tr[T](*, pl: T, en: T) -> T:
    """The variant of the current language: ``tr(pl="Wydatki", en="Expenses")``."""
    return en if lang() == "en" else pl


def pl_form(n: int, one: str, few: str, many: str) -> str:
    """Polish word form: ``pl_form(5, "sygnał", "sygnały", "sygnałów")`` -> ``"sygnałów"``."""
    n = abs(n)
    if n == 1:
        return one
    return few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many


def en_form(n: int, one: str, other: str) -> str:
    return one if abs(n) == 1 else other


def pl_count(n: int, one: str, few: str, many: str) -> str:
    """``"5 sygnałów"``."""
    return f"{n} {pl_form(n, one, few, many)}"


def en_count(n: int, one: str, other: str) -> str:
    """``"5 signals"``."""
    return f"{n} {en_form(n, one, other)}"


class LanguageMiddleware:
    """Pure ASGI middleware: ``X-Cashu-Lang`` becomes the request's language and the app language."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        value = parse_lang(Headers(scope=scope).get(LANG_HEADER))
        if value is None:
            await self.app(scope, receive, send)
            return
        remember_app_language(value)
        token = _current.set(value)
        try:
            await self.app(scope, receive, send)
        finally:
            _current.reset(token)
