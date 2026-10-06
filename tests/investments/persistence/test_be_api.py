"""F6 backend integration endpoints: alert soft delete + restore (15 minutes, same id, the closed
signal re-opened), planned deposits, instrument labels, coded messages, digest bucket ids."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import AS_OF, HEADER, STRATEGY_YAML, canonical_csv, sources
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.models import InvAlert, InvSignal
from cashu.modules.investments.service import alerts as alert_service
from cashu.modules.investments.service import daily, files, portfolio


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
    assert r.status_code == 404 and r.headers["X-Cashu-Error-Code"] == "not_found"
    assert client.post(f"{base}/alerts/999/restore").status_code == 404

    profile = _profile(slug)
    old = utcnow() - dt.timedelta(minutes=16)
    with get_session() as s:
        alert_service.delete(s, profile, late["id"], now=old)
    r = client.post(f"{base}/alerts/{late['id']}/restore")
    assert r.status_code == 409 and r.headers["X-Cashu-Error-Code"] == "undo_expired"

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
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "alert_invalid"


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


PLAN_STRATEGY = STRATEGY_YAML + "contributions:\n  monthly_amount: 1500\n  day_of_month: 10\n"
DEPOSIT_ROW = "1,txn,{date},,deposit,{ref},,,,,,,PLN,,,,{amount},,,,"


def _import_rows(client, slug: str, account: int, *rows: str) -> dict:
    content = ("\n".join([HEADER, *rows]) + "\n").encode()
    preview = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("more.csv", content, "text/csv")},
        data={"account_id": str(account)},
    ).json()
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": "more.csv", "account_id": account},
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_planned_deposits_lifecycle_and_month_plan(client):
    slug, account = household(client)
    other, _ = household(client, "Basia")
    files.write_text_private(files.strategy_yaml_path(slug), PLAN_STRATEGY)
    base = f"/api/p/{slug}/investments"
    cash_before = client.get(f"{base}/overview").json()["kpis"]["cash"]

    for bad, code in (
        ({"amount": 0, "planned_date": "2026-03-10"}, 422),
        ({"amount": "x", "planned_date": "2026-03-10"}, 422),
        ({"amount": 10, "planned_date": "2025-01-10"}, 422),  # more than a month back
        ({"amount": 10, "planned_date": "2026-03-10", "currency": "zloty"}, 422),
        ({"amount": 10, "planned_date": "2026-03-10", "account_id": 9999}, 404),
    ):
        r = client.post(f"{base}/planned-deposits", json=bad)
        assert r.status_code == code, (bad, r.text)
        expected = "planned_invalid" if code == 422 else "not_found"
        assert r.headers["X-Cashu-Error-Code"] == expected

    r = client.post(
        f"{base}/planned-deposits",
        json={
            "amount": 1000,
            "planned_date": "2026-03-05",
            "account_id": account,
            "note": "marzec",
        },
    )
    assert r.status_code == 201, r.text
    plan = r.json()
    assert (plan["status"], plan["amount"], plan["currency"]) == ("planned", 1000.0, "PLN")
    later = client.post(
        f"{base}/planned-deposits", json={"amount": 300, "planned_date": "2026-03-25"}
    ).json()
    assert later["account_id"] is None and later["currency"] == "PLN"  # base currency

    listed = client.get(f"{base}/planned-deposits").json()
    assert [p["id"] for p in listed["items"]] == [later["id"], plan["id"]]
    assert listed["plan"] == {
        "month": "2026-03",
        "currency": "PLN",
        "monthly_amount": 1500.0,
        "day_of_month": 10,
        "deposited": 0.0,
        "planned": 1300.0,
        "remaining": 200.0,
        "covered": False,
        "planned_count": 2,
    }
    # never cash or value until booked
    assert client.get(f"{base}/overview").json()["kpis"]["cash"] == cash_before
    assert client.get(f"/api/p/{other}/investments/planned-deposits").json()["items"] == []
    assert (
        client.delete(f"/api/p/{other}/investments/planned-deposits/{plan['id']}").status_code
        == 404
    )

    # an imported deposit within the window and 10 % of the amount books the plan
    committed = _import_rows(
        client, slug, account, DEPOSIT_ROW.format(date="2026-03-02", ref="P-1", amount="980.00")
    )
    assert committed["planned_booked"] == [plan["id"]]
    items = {p["id"]: p for p in client.get(f"{base}/planned-deposits").json()["items"]}
    booked = items[plan["id"]]
    assert booked["status"] == "booked" and booked["booked_txn_id"] is not None
    assert items[later["id"]]["status"] == "planned"  # 300 does not match a 980 deposit
    month = client.get(f"{base}/planned-deposits").json()["plan"]
    assert (month["deposited"], month["planned"], month["remaining"]) == (980.0, 300.0, 220.0)
    r = client.delete(f"{base}/planned-deposits/{plan['id']}")
    assert r.status_code == 409 and r.headers["X-Cashu-Error-Code"] == "planned_booked"

    assert client.delete(f"{base}/planned-deposits/{later['id']}").json() == {
        "deleted": later["id"],
        "status": "cancelled",
    }
    assert later["id"] not in [
        p["id"] for p in client.get(f"{base}/planned-deposits").json()["items"]
    ]
    every = client.get(f"{base}/planned-deposits?status=all").json()["items"]
    assert {p["status"] for p in every} == {"booked", "cancelled"}
    assert client.get(f"{base}/planned-deposits?status=nope").status_code == 422
    assert client.get(f"{base}/planned-deposits?month=2026-13").status_code == 422


def test_a_plan_for_a_deposit_already_made_is_booked_at_once_and_once_only(client):
    slug, account = household(client)
    base = f"/api/p/{slug}/investments"
    _import_rows(
        client, slug, account, DEPOSIT_ROW.format(date="2026-02-27", ref="P-2", amount="500.00")
    )
    first = client.post(
        f"{base}/planned-deposits", json={"amount": 500, "planned_date": "2026-03-01"}
    ).json()
    assert first["status"] == "booked"
    # the same deposit cannot book a second plan
    second = client.post(
        f"{base}/planned-deposits", json={"amount": 500, "planned_date": "2026-03-01"}
    ).json()
    assert second["status"] == "planned"
    # a manual deposit books it
    r = client.post(
        f"{base}/transactions",
        json={
            "account_id": account,
            "type": "deposit",
            "trade_date": "2026-03-02",
            "cash_amount": 510,
            "currency": "PLN",
        },
    )
    assert r.status_code == 201, r.text
    items = {p["id"]: p for p in client.get(f"{base}/planned-deposits").json()["items"]}
    assert items[second["id"]]["status"] == "booked"
    assert items[second["id"]]["booked_txn_id"] != items[first["id"]]["booked_txn_id"]
