"""Backend UI language (core/i18n.py): the request header, the stored app language, plurals."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cashu.core import i18n


def test_parse_lang():
    assert i18n.parse_lang("en-GB") == "en"
    assert i18n.parse_lang("pl_PL.UTF-8") == "pl"
    assert i18n.parse_lang("de") is None
    assert i18n.parse_lang(None) is None


def test_tests_pin_polish_and_use_language_switches():
    assert i18n.lang() == "pl"
    assert i18n.tr(pl="Wydatki", en="Expenses") == "Wydatki"
    with i18n.use_language("en"):
        assert i18n.tr(pl="Wydatki", en="Expenses") == "Expenses"
    assert i18n.lang() == "pl"


def test_app_language_order(monkeypatch):
    monkeypatch.delenv(i18n.LANG_ENV)
    monkeypatch.setattr(i18n, "os_language", lambda: "pl")
    assert i18n.app_language() == "pl"  # no stored choice: the OS language
    i18n.remember_app_language("en")
    assert json.loads(i18n.settings_path().read_text())["language"] == "en"
    assert i18n.app_language() == "en"  # the dashboard's language wins over the OS
    monkeypatch.setattr(i18n, "os_language", lambda: None)
    i18n.settings_path().unlink()
    assert i18n.app_language() == i18n.FALLBACK_LANG == "en"


@pytest.mark.parametrize("sync", [True, False])
def test_middleware_sets_the_request_language(sync, monkeypatch):
    monkeypatch.delenv(i18n.LANG_ENV)
    monkeypatch.setattr(i18n, "os_language", lambda: None)
    app = FastAPI()
    app.add_middleware(i18n.LanguageMiddleware)

    if sync:
        @app.get("/t")
        def endpoint() -> dict:
            return {"text": i18n.tr(pl="Wydatki", en="Expenses")}
    else:
        @app.get("/t")
        async def endpoint() -> dict:
            return {"text": i18n.tr(pl="Wydatki", en="Expenses")}

    client = TestClient(app)
    assert client.get("/t", headers={"X-Cashu-Lang": "pl"}).json() == {"text": "Wydatki"}
    assert client.get("/t", headers={"X-Cashu-Lang": "en"}).json() == {"text": "Expenses"}
    # no header: the app language, which the last request remembered
    assert client.get("/t").json() == {"text": "Expenses"}
    assert i18n.app_language() == "en"


def test_plurals():
    assert [i18n.pl_count(n, "sygnał", "sygnały", "sygnałów") for n in (1, 2, 5, 12, 22)] == [
        "1 sygnał", "2 sygnały", "5 sygnałów", "12 sygnałów", "22 sygnały",
    ]
    assert i18n.en_count(1, "signal", "signals") == "1 signal"
    assert i18n.en_count(3, "signal", "signals") == "3 signals"
