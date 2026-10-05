"""F5 endpoints: alerts (catalog, CRUD, snooze / mute / re-arm, error codes), watchlist (resolution,
conflicts), overview polarity counts and attention, signal snooze, decision undo, review digest
(``since``, events, contributions vs market part), positions ``closes_30d``, the streamed upload limit."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import AS_OF, HEADER, ROWS, STRATEGY_YAML, canonical_csv, sources
from sqlmodel import select

from finanse.core.db import get_session
from finanse.modules.investments import api as inv_api
from finanse.modules.investments.models import InvDecision
from finanse.modules.investments.service import daily, files, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def household(client, name: str = "Anna", content: bytes | None = None) -> tuple[str, int]:
    slug = client.post("/api/profiles", json={"name": name, "modules": ["investments"]}).json()[
        "slug"
    ]
    aid = client.post(
        f"/api/p/{slug}/investments/accounts", json={"name": "DIF", "broker": "dif"}
    ).json()["id"]
    preview = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("h.csv", content or canonical_csv(), "text/csv")},
        data={"account_id": str(aid)},
    ).json()
    client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": "h.csv", "account_id": aid},
    )
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return slug, aid


def ids(client, slug: str) -> dict[str, int]:
    return {
        i["label"]: i["id"] for i in client.get(f"/api/p/{slug}/investments/instruments").json()
    }


def test_alert_kinds_and_alert_crud(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    kinds = client.get(f"{base}/alert-kinds").json()
    assert [k["kind"] for k in kinds["kinds"]][:2] == ["price_above", "price_below"]
    assert kinds["polarities"] == ["positive", "negative", "neutral"]
    xmpl = ids(client, slug)["XMPL"]

    r = client.post(
        f"{base}/alerts",
        json={"kind": "price_abve", "params": {}, "instrument_id": xmpl, "title": "x"},
    )
    assert r.status_code == 422 and r.headers["X-Finanse-Error-Code"] == "alert_invalid"
    assert 'did you mean "price_above"' in r.json()["detail"]
    r = client.post(
        f"{base}/alerts",
        json={"kind": "price_above", "params": {"levle": 1}, "instrument_id": xmpl, "title": "x"},
    )
    assert "params.levle" in r.json()["detail"]
    r = client.post(
        f"{base}/alerts",
        json={"kind": "price_above", "params": {"level": 1}, "instrument_id": 999, "title": "x"},
    )
    assert r.status_code == 404 and r.headers["X-Finanse-Error-Code"] == "not_found"
    r = client.post(
        f"{base}/alerts",
        json={
            "kind": "price_above",
            "params": {"level": 90},
            "instrument_id": xmpl,
            "title": "XMPL over 90",
            "polarity": "positive",
            "severity": "action",
            "cooldown_days": 3,
            "expires_in_days": 30,
        },
    )
    assert r.status_code == 201, r.text
    alert = r.json()
    assert (alert["status"], alert["source"], alert["created_by"]) == ("active", "user", "app")
    assert alert["instrument"]["label"] == "XMPL" and alert["unit"] == "price"
    assert alert["params"] == {"level": 90.0} and alert["expires_at"] is not None

    client.post(f"{base}/run", json={})
    (listed,) = client.get(f"{base}/alerts?status=live").json()
    assert listed["status"] == "triggered" and listed["signal"]["status"] == "active"
    assert listed["last_value"] == 100.0
    assert client.get(f"{base}/alerts?status=muted").json() == []
    assert client.get(f"{base}/alerts?status=bogus").status_code == 422

    aid = alert["id"]
    r = client.patch(f"{base}/alerts/{aid}", json={"params": {"level": 120}, "title": "XMPL 120"})
    assert r.json()["params"] == {"level": 120.0} and r.json()["title"] == "XMPL 120"
    assert client.patch(f"{base}/alerts/{aid}", json={"kind": "x"}).status_code == 422
    assert client.patch(f"{base}/alerts/{aid}", json={"status": "triggered"}).status_code == 422
    snoozed = client.patch(f"{base}/alerts/{aid}", json={"status": "snoozed", "snooze_days": 2})
    assert snoozed.json()["status"] == "snoozed" and snoozed.json()["signal"] is None
    rearmed = client.patch(f"{base}/alerts/{aid}", json={"status": "active"}).json()
    assert rearmed["status"] == "active" and rearmed["snoozed_until"] is None
    assert (
        client.patch(f"{base}/alerts/{aid}", json={"status": "muted"}).json()["status"] == "muted"
    )
    deleted = client.delete(f"{base}/alerts/{aid}").json()
    assert deleted["deleted"] == aid and deleted["restore_until"] is not None  # F6: soft delete
    assert client.delete(f"{base}/alerts/{aid}").status_code == 404


def test_watchlist_api(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    r = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE", "tags": ["etf"]})
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["created_instrument"] is True and item["warnings"]
    inst = item["instrument"]
    assert (inst["symbol"], inst["currency"], inst["mic"]) == ("VWCE", "EUR", "XETR")
    assert {"namespace": "yahoo", "value": "VWCE.DE", "guessed": True} in inst["aliases"]
    assert item["tags"] == ["etf"] and item["held"] is False and item["price"] is None
    again = client.post(f"{base}/watchlist", json={"symbol_or_isin": "vwce.de"})
    assert (
        again.status_code == 409 and again.headers["X-Finanse-Error-Code"] == "watchlist_conflict"
    )
    # an instrument the profile holds, by ISIN: no new instrument, flagged held
    held = client.post(f"{base}/watchlist", json={"symbol_or_isin": "US0000000001"}).json()
    assert held["created_instrument"] is False and held["held"] is True
    unknown_isin = client.post(f"{base}/watchlist", json={"symbol_or_isin": "IE00B4L5Y983"})
    assert unknown_isin.status_code == 422 and "give its currency" in unknown_isin.json()["detail"]
    with_currency = client.post(
        f"{base}/watchlist", json={"symbol_or_isin": "IE00B4L5Y983", "currency": "eur"}
    ).json()
    assert (
        with_currency["price_source"] is False and "No Yahoo symbol" in with_currency["warnings"][0]
    )
    bare = client.post(f"{base}/watchlist", json={"symbol_or_isin": "MSFT"})
    assert bare.status_code == 422 and "MSFT.US" in bare.json()["detail"]
    us = client.post(f"{base}/watchlist", json={"symbol_or_isin": "MSFT", "exchange": "nasdaq"})
    assert us.json()["instrument"]["currency"] == "USD"
    bad = client.post(f"{base}/watchlist", json={"symbol_or_isin": "X", "exchange": "MARS"})
    assert bad.status_code == 422 and 'Unknown exchange "MARS"' in bad.json()["detail"]
    assert client.post(f"{base}/watchlist", json={"symbol_or_isin": "a b"}).status_code == 422
    patched = client.patch(f"{base}/watchlist/{item['id']}", json={"note": "later"}).json()
    assert patched["note"] == "later"
    # watched instruments are the profile's instruments (classification, chart routes)
    assert "VWCE" in ids(client, slug)
    assert client.get(f"{base}/positions/{inst['id']}/chart").status_code == 200
    listed = client.get(f"{base}/watchlist").json()
    assert [r["instrument"]["label"] for r in listed][:2] == ["VWCE", "XMPL"]
    assert client.delete(f"{base}/watchlist/{item['id']}").json() == {"deleted": item["id"]}
    assert client.delete(f"{base}/watchlist/{item['id']}").status_code == 404


def test_overview_polarity_attention_and_signal_snooze(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    xmpl = ids(client, slug)["XMPL"]
    client.post(
        f"{base}/alerts",
        json={
            "kind": "price_above",
            "params": {"level": 90},
            "instrument_id": xmpl,
            "title": "XMPL over 90",
            "polarity": "positive",
        },
    )
    client.post(f"{base}/run", json={})
    ov = client.get(f"{base}/overview").json()
    assert ov["kpis"]["polarity"] == {"positive": 1, "negative": 1, "neutral": 0}
    assert ov["kpis"]["alerts"]["triggered"] == 1
    first, second = ov["attention"]
    # action before info: the concentration rule first, then the alert (info, positive)
    assert (first["type"], first["polarity"], first["severity"]) == ("signal", "negative", "action")
    assert (second["type"], second["title"], second["source"]) == ("alert", "XMPL over 90", "user")
    assert second["held"] is True and ov["attention_total"] == 2
    signals = client.get(f"{base}/signals").json()
    assert {s["source"] for s in signals} == {"rule", "alert"}
    assert all("polarity" in s and s["snoozed"] is False for s in signals)

    sid = first["signal_id"]
    past = client.post(f"{base}/signals/{sid}/snooze", json={"until": "2020-01-01"})
    assert past.status_code == 422
    assert client.post(f"{base}/signals/{sid}/snooze", json={"until": "soon"}).status_code == 422
    assert client.post(f"{base}/signals/99999/snooze", json={"until": None}).status_code == 404
    until = (dt.date.today() + dt.timedelta(days=5)).isoformat()  # noqa: DTZ011
    snoozed = client.post(f"{base}/signals/{sid}/snooze", json={"until": until}).json()
    assert snoozed["snoozed"] is True and snoozed["snoozed_until"]
    ov = client.get(f"{base}/overview").json()
    assert [a["signal_id"] for a in ov["attention"]] == [second["signal_id"]]
    assert ov["attention_snoozed"] == 1
    back = client.post(f"{base}/signals/{sid}/snooze", json={"until": None}).json()
    assert back["snoozed"] is False


def test_decision_undo_within_fifteen_minutes(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    client.post(f"{base}/run", json={})
    (sig,) = client.get(f"{base}/signals").json()
    made = client.post(f"{base}/signals/{sig['id']}/decision", json={"action": "held"}).json()
    assert made["signal"]["status"] == "acknowledged"
    undone = client.delete(f"{base}/decisions/{made['decision']['id']}").json()
    assert undone["signal"]["status"] == "active" and undone["signal"]["acknowledged_at"] is None
    assert client.get(f"{base}/decisions").json() == []
    late = client.post(f"{base}/signals/{sig['id']}/decision", json={"action": "sold"}).json()
    with get_session() as s:
        row = s.get(InvDecision, late["decision"]["id"])
        row.created_at = row.created_at - dt.timedelta(minutes=16)
        s.add(row)
    r = client.delete(f"{base}/decisions/{late['decision']['id']}")
    assert r.status_code == 409 and r.headers["X-Finanse-Error-Code"] == "undo_expired"
    other, _ = household(client, "Bartek")
    assert (
        client.delete(f"/api/p/{other}/investments/decisions/{late['decision']['id']}").status_code
        == 404
    )
    with get_session() as s:
        assert s.exec(select(InvDecision)).all()


def test_review_digest_since_events_and_contributions(client):
    deposit = "1,txn,2026-02-20,,deposit,T-10,,,,,,,PLN,,,,1000.00,,,,"
    content = ("\n".join([HEADER, *ROWS, deposit]) + "\n").encode()
    slug, _ = household(client, content=content)
    base = f"/api/p/{slug}/investments"
    client.post(f"{base}/run", json={})
    sig = client.get(f"{base}/signals").json()[0]
    client.post(f"{base}/signals/{sig['id']}/decision", json={"action": "held"})
    digest = client.get(f"{base}/review-digest?since=2026-02-10").json()
    assert digest["baseline"] == "since" and digest["since"] == "2026-02-10"
    value = digest["value"]
    assert value["contributions"] == 1000.0
    assert value["change"] == pytest.approx(value["contributions"] + value["market_change"])
    types = [e["type"] for e in digest["events"]]
    assert {"signal_created", "import", "decision", "deposit"} <= set(types)
    dep = next(e for e in digest["events"] if e["type"] == "deposit")
    assert (dep["date"], dep["amount"], dep["currency"]) == ("2026-02-20", 1000.0, "PLN")
    assert digest["events_total"] == len(digest["events"])
    assert client.get(f"{base}/review-digest?since=2999-01-01").status_code == 422


def test_positions_carry_closes_30d(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    client.post(f"{base}/run", json={})
    positions = client.get(f"{base}/positions").json()["positions"]
    xmpl = next(p for p in positions if p["instrument"]["label"] == "XMPL")
    closes = xmpl["closes_30d"]
    assert closes[-1] == {"date": AS_OF.isoformat(), "close": 100.0}
    assert all(dt.date.fromisoformat(c["date"]) > AS_OF - dt.timedelta(days=30) for c in closes)
    assert 18 <= len(closes) <= 23  # weekdays only


def test_upload_size_is_enforced_while_streaming(client, monkeypatch):
    slug, aid = household(client)
    monkeypatch.setattr(inv_api, "MAX_UPLOAD_BYTES", 2000)
    url = f"/api/p/{slug}/investments/import/preview?account_id={aid}&filename=x.csv"
    big = b"x" * 5000
    r = client.post(url, content=big, headers={"content-type": "text/csv"})
    assert r.status_code == 413
    r = client.post(url, content=big, headers={"content-type": "text/csv", "content-length": "z"})
    assert r.status_code in (400, 413)

    def chunks():
        for _ in range(5):
            yield b"y" * 1000

    r = client.post(url, content=chunks(), headers={"content-type": "text/csv"})
    assert r.status_code == 413
