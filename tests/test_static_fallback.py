"""The legacy single-file dashboard is gone: without a built SPA, `/` serves a minimal page that says
how to build the frontend (still carrying the token meta tag and the security headers)."""

from __future__ import annotations

import importlib

from finanse.core import security

app_mod = importlib.import_module("finanse.api.app")  # the module (finanse.api re-exports `app`)


def test_without_webdist_the_shell_explains_how_to_build(api_empty, monkeypatch, tmp_path):
    monkeypatch.setattr(app_mod, "WEBDIST", tmp_path / "no-webdist")
    r = api_empty.get("/")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert "npm run build" in r.text and "Interfejs nie jest zbudowany" in r.text
    assert f'<meta name="{security.TOKEN_META}" content="{security.get_config().token}" />' in r.text
    assert r.headers["X-Frame-Options"] == "DENY"


def test_fallback_page_is_static_and_self_contained():
    page = (app_mod.STATIC / "index.html").read_text(encoding="utf-8")
    assert "<script" not in page  # no legacy dashboard code, no vendored chart libraries
    assert "\u2014" not in page  # no em dash
    assert sorted(p.name for p in app_mod.STATIC.iterdir()) == ["index.html"]
