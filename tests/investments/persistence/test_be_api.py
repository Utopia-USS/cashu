"""F6 backend integration endpoints: alert soft delete + restore (15 minutes, same id, the closed
signal re-opened), instrument labels, coded messages, digest bucket ids."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import AS_OF, STRATEGY_YAML, canonical_csv, sources
from sqlmodel import select

from finanse.core.db import get_session
from finanse.core.models import Profile, utcnow
from finanse.modules.investments.models import InvAlert, InvSignal
from finanse.modules.investments.service import alerts as alert_service
from finanse.modules.investments.service import daily, files, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def household(client, name: str = "Anna") -> tuple[str, int]:
    slug = client.post("/api/profiles", json={"name": name, "modules": ["investments"]}).json()[
        "slug"
    ]
    aid = client.post(
        f"/api/p/{slug}/investments/accounts", json={"name": "DIF", "broker": "dif"}
    ).json()["id"]
    preview = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("h.csv", canonical_csv(), "text/csv")},
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


def _price_alert(client, base: str, instrument_id: int, level: float = 90) -> dict:
    r = client.post(
        f"{base}/alerts",
        json={
            "kind": "price_above",
            "params": {"level": level},
            "instrument_id": instrument_id,
            "title": f"over {level}",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _profile(slug: str) -> Profile:
    with get_session() as s:
        return s.exec(select(Profile).where(Profile.slug == slug)).one()


def test_alert_delete_and_restore_keeps_the_id_and_reopens_its_signal(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    alert = _price_alert(client, base, ids(client, slug)["XMPL"])
    client.post(f"{base}/run", json={})
    (live,) = client.get(f"{base}/alerts").json()
    assert live["status"] == "triggered" and live["signal"]["status"] == "active"
    signal_id = live["signal"]["id"]

    deleted = client.delete(f"{base}/alerts/{alert['id']}").json()
    assert deleted["deleted"] == alert["id"]
    restore_until = dt.datetime.fromisoformat(deleted["restore_until"])
    assert dt.timedelta(minutes=14) < restore_until - utcnow() <= dt.timedelta(minutes=15)
    assert client.get(f"{base}/alerts").json() == []
    assert client.get(f"{base}/overview").json()["kpis"]["alerts"]["triggered"] == 0
    assert client.patch(f"{base}/alerts/{alert['id']}", json={"title": "x"}).status_code == 404
    with get_session() as s:
        assert s.get(InvSignal, signal_id).status == "expired"

    restored = client.post(f"{base}/alerts/{alert['id']}/restore")
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert (body["id"], body["status"], body["title"]) == (alert["id"], "triggered", "over 90")
    assert body["signal"]["id"] == signal_id and body["signal"]["status"] == "active"
    assert [a["id"] for a in client.get(f"{base}/alerts").json()] == [alert["id"]]
    # restoring a live alert is a no-op; the next check keeps the same signal open
    assert client.post(f"{base}/alerts/{alert['id']}/restore").json()["id"] == alert["id"]
    client.post(f"{base}/run", json={})
    (again,) = client.get(f"{base}/alerts").json()
    assert again["signal"]["id"] == signal_id


def test_alert_restore_window_other_profiles_and_tombstones(client):
    slug, _ = household(client)
    other, _ = household(client, "Basia")
    base = f"/api/p/{slug}/investments"
    alert = _price_alert(client, base, ids(client, slug)["XMPL"], level=500)  # never fires
    late = _price_alert(client, base, ids(client, slug)["XMPL"], level=600)

    assert client.delete(f"/api/p/{other}/investments/alerts/{alert['id']}").status_code == 404
    client.delete(f"{base}/alerts/{alert['id']}")
    r = client.post(f"/api/p/{other}/investments/alerts/{alert['id']}/restore")
    assert r.status_code == 404 and r.headers["X-Finanse-Error-Code"] == "not_found"
    assert client.post(f"{base}/alerts/999/restore").status_code == 404

    profile = _profile(slug)
    old = utcnow() - dt.timedelta(minutes=16)
    with get_session() as s:
        alert_service.delete(s, profile, late["id"], now=old)
    r = client.post(f"{base}/alerts/{late['id']}/restore")
    assert r.status_code == 409 and r.headers["X-Finanse-Error-Code"] == "undo_expired"

    # an untriggered alert comes back active; an expired deletion stays a hidden tombstone
    assert client.post(f"{base}/alerts/{alert['id']}/restore").json()["status"] == "active"
    client.post(f"{base}/run", json={})
    with get_session() as s:
        assert s.get(InvAlert, late["id"]).deleted_at is not None
        assert s.get(InvAlert, alert["id"]).deleted_at is None
    assert [a["id"] for a in client.get(f"{base}/alerts").json()] == [alert["id"]]


def test_a_deleted_alert_id_is_never_reused(client):
    """F6 review V8: the newest alert deleted, the next one gets a new id and no inherited signals."""
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    first = _price_alert(client, base, ids(client, slug)["XMPL"])
    client.post(f"{base}/run", json={})
    client.delete(f"{base}/alerts/{first['id']}")
    second = _price_alert(client, base, ids(client, slug)["XMPL"], level=500)
    assert second["id"] > first["id"] and second["signal"] is None
    signals = client.get(f"{base}/signals?status=all").json()
    assert [s["alert_id"] for s in signals if s["source"] == "alert"] == [first["id"]]


def test_restoring_an_agent_alert_respects_the_cap(client, monkeypatch):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    xmpl = ids(client, slug)["XMPL"]
    profile = _profile(slug)
    monkeypatch.setattr(alert_service, "AGENT_ALERT_LIMIT", 1)
    with get_session() as s:
        first = alert_service.create(
            s,
            profile,
            alert_service.AlertInput(
                kind="price_above", title="a", params={"level": 500}, instrument_id=xmpl
            ),
            source=alert_service.AlertSource.AGENT,
            created_by="mcp",
        ).id
    client.delete(f"{base}/alerts/{first}")
    with get_session() as s:
        alert_service.create(
            s,
            profile,
            alert_service.AlertInput(
                kind="price_above", title="b", params={"level": 501}, instrument_id=xmpl
            ),
            source=alert_service.AlertSource.AGENT,
            created_by="mcp",
        )
    r = client.post(f"{base}/alerts/{first}/restore")
    assert r.status_code == 422 and r.headers["X-Finanse-Error-Code"] == "alert_invalid"


DRIFT_STRATEGY = (
    STRATEGY_YAML
    + """  - id: drift
    kind: allocation_drift
    params: { absolute_band_pp: 1, relative_band: 0.01, min_trade_value: 0 }
"""
)


def test_alert_signals_carry_message_code_and_params(client):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    _price_alert(client, base, ids(client, slug)["XMPL"])
    client.post(f"{base}/run", json={})
    signals = client.get(f"{base}/signals").json()
    (alert_signal,) = [s for s in signals if s["source"] == "alert"]
    assert alert_signal["message_code"] == "alert.price_above"
    assert alert_signal["message_params"] == {
        "title": "over 90",
        "label": "XMPL",
        "close": "100",
        "level": "90",
        "currency": "USD",
        "date": AS_OF.isoformat(),
    }
    assert all(s["message_code"] is None for s in signals if s["source"] == "rule")
    (alert,) = client.get(f"{base}/alerts").json()
    assert alert["signal"]["message_code"] == "alert.price_above"
    attention = client.get(f"{base}/overview").json()["attention"]
    coded = next(a for a in attention if a["type"] == "alert")
    assert coded["message_params"]["level"] == "90"
    events = client.get(f"{base}/review-digest").json()["events"]
    triggered = next(e for e in events if e["type"] == "alert_triggered")
    assert triggered["message_code"] == "alert.price_above"


def test_drift_digest_events_carry_the_bucket_and_drift_is_neutral(client):
    slug, _ = household(client)
    files.write_text_private(files.strategy_yaml_path(slug), DRIFT_STRATEGY)
    base = f"/api/p/{slug}/investments"
    client.post(f"{base}/run", json={})
    drift = [s for s in client.get(f"{base}/signals").json() if s["kind"] == "allocation_drift"]
    assert drift and {s["polarity"] for s in drift} == {"neutral"}
    events = client.get(f"{base}/review-digest").json()["events"]
    drift_events = [e for e in events if e.get("kind") == "allocation_drift"]
    assert {e["bucket_id"] for e in drift_events} == {s["payload"]["bucket_id"] for s in drift}
    assert all(e["bucket_id"] is None for e in events if e.get("kind") == "cash_level")


def test_watchlist_warnings_have_codes_and_labels_stay_symbols(client):
    slug, account = household(client)
    base = f"/api/p/{slug}/investments"
    r = client.post(f"{base}/watchlist", json={"symbol_or_isin": "EXMP.DE", "name": "Example AG"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["warnings"] == [w["message"] for w in body["warning_codes"]]
    assert body["warning_codes"][0]["code"] == "watchlist.guessed_price_symbol"
    assert body["warning_codes"][0]["params"] == {
        "symbol": "EXMP",
        "currency": "EUR",
        "price_symbol": "EXMP.DE",
    }
    # label = symbol for watched and manual instruments alike; name = the display name
    assert (body["instrument"]["label"], body["instrument"]["name"]) == ("EXMP", "Example AG")
    isin = client.post(
        f"{base}/watchlist", json={"symbol_or_isin": "DE000EXMPL01", "currency": "EUR"}
    ).json()
    assert isin["warning_codes"][0] == {
        "code": "watchlist.no_price_symbol",
        "params": {"isin": "DE000EXMPL01"},
        "message": isin["warnings"][0],
    }
    manual = client.post(
        f"{base}/transactions",
        json={
            "account_id": account,
            "type": "buy",
            "trade_date": "2026-02-02",
            "instrument": {"symbol": "BOND1", "name": "Example bond", "currency": "PLN"},
            "quantity": 1,
            "price": 100,
            "currency": "PLN",
        },
    )
    assert manual.status_code == 201, manual.text
    inst = manual.json()["instrument"]
    assert (inst["label"], inst["name"]) == ("BOND1", "Example bond")


def test_import_preview_warnings_carry_a_code(client):
    slug, account = household(client)
    content = canonical_csv(extra=["1,txn,2026-02-03,,bogus_type,T-77,,,,,,,PLN,,,,1.00,,,,"])
    preview = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("w.csv", content, "text/csv")},
        data={"account_id": str(account)},
    ).json()
    problems = preview["warnings"] + preview["errors"]
    assert problems and all(p["code"] == f"import.{p['kind']}" for p in problems)
