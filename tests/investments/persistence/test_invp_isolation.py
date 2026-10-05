"""Profile isolation for every investments endpoint (the pattern of tests/test_profiles.py): two
profiles with the same synthetic history see exactly the same thing (ids, timestamps and slugs
stripped), an empty profile sees nothing, and writes through one profile never reach the other."""

from __future__ import annotations

import re

import pytest
from invp_support import AS_OF, HEADER, ROWS, STRATEGY_YAML, canonical_csv, sources

from finanse.api.app import app
from finanse.modules.investments.service import daily, files, portfolio

# Every investments GET route ({instrument_id} is filled per test), with the variants worth comparing.
INVESTMENTS_GETS = [
    "/investments/overview",
    "/investments/performance",
    "/investments/performance?range=max",
    "/investments/performance/attribution",
    "/investments/positions",
    "/investments/positions/{instrument_id}",
    "/investments/positions/{instrument_id}/chart",
    "/investments/transactions",
    "/investments/signals",
    "/investments/signals?status=history",
    "/investments/signals?status=all",
    "/investments/decisions",
    "/investments/review-digest",
    "/investments/instruments",
    "/investments/instruments?unclassified=true",
    "/investments/instruments/{instrument_id}/theses",
    "/investments/manual-valuations",
    "/investments/strategy",
    "/investments/accounts",
    "/investments/imports",
    "/investments/reconciliation",
    "/investments/runs",
    "/investments/alerts",
    "/investments/alerts?status=live",
    "/investments/alert-kinds",
    "/investments/watchlist",
    "/investments/research",
    "/investments/research/summary",
    "/investments/research/runs",
    "/investments/planned-deposits",
]
VOLATILE = {
    "id",
    "account_id",
    "run_id",
    "batch_id",
    "open_txn_id",
    "signal_id",
    "alert_id",
    "decision_id",
    "new_signal_ids",
    "escalated_signal_ids",
    "sha256",
    "accounts_filter",
}


def strip(value, slug: str):
    if isinstance(value, dict):
        return {
            k: strip(v, slug)
            for k, v in value.items()
            if k not in VOLATILE
            and not k.endswith("_at")
            and k != "at"
            # an instant (the digest research block's baseline), unlike the date-level "since"
            and not (k == "since" and isinstance(v, str) and "T" in v)
        }
    if isinstance(value, list):
        return [strip(v, slug) for v in value]
    if isinstance(value, str):
        value = re.sub(r"\balert:\d+\b", "alert:<id>", value)  # alert signal rule ids / keys
        return re.sub(rf"\b{re.escape(slug)}\b", "<slug>", value)
    return value


def snapshot(client, slug: str, instrument_id: int) -> dict:
    out = {}
    for path in INVESTMENTS_GETS:
        url = f"/api/p/{slug}{path.format(instrument_id=instrument_id)}"
        r = client.get(url)
        assert r.status_code == 200, (url, r.status_code, r.text)
        out[path] = strip(r.json(), slug)
    return out


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def household(client, name: str) -> tuple[str, int, int]:
    """A profile with the synthetic history, a strategy, one run, a decision, a thesis and a manual
    valuation. Returns (slug, account id, XMPL instrument id)."""
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
    # a watched instrument and a firing alert on a held one (F5)
    assert (
        client.post(
            f"/api/p/{slug}/investments/watchlist",
            json={"symbol_or_isin": "WATCH.DE", "note": "Example watch"},
        ).status_code
        == 201
    )
    xmpl_id = next(
        i["id"]
        for i in client.get(f"/api/p/{slug}/investments/instruments").json()
        if i["label"] == "XMPL"
    )
    r = client.post(
        f"/api/p/{slug}/investments/alerts",
        json={
            "kind": "price_above",
            "params": {"level": 50},
            "instrument_id": xmpl_id,
            "title": "XMPL above 50",
            "polarity": "positive",
        },
    )
    assert r.status_code == 201, r.text
    assert client.post(f"/api/p/{slug}/investments/run", json={}).status_code == 200
    signals = client.get(f"/api/p/{slug}/investments/signals").json()
    assert sorted(s["source"] for s in signals) == ["alert", "rule"]
    sig = next(s for s in signals if s["source"] == "rule")
    client.post(f"/api/p/{slug}/investments/signals/{sig['id']}/decision", json={"action": "held"})
    xmpl = sig["instrument_id"]
    client.post(
        f"/api/p/{slug}/investments/instruments/{xmpl}/theses",
        json={"entry_type": "trend", "thesis": "Example thesis"},
    )
    client.post(
        f"/api/p/{slug}/investments/manual-valuations",
        json={"instrument_id": xmpl, "unit_value": "99", "as_of": "2026-02-01"},
    )
    return slug, aid, xmpl


def test_every_investments_route_is_in_the_isolation_list():
    templates = {
        path.removeprefix("/api/p/{slug}")
        for path, ops in app.openapi()["paths"].items()
        if path.startswith("/api/p/{slug}/investments/") and "get" in ops
    }
    covered = {p.split("?")[0] for p in INVESTMENTS_GETS}
    assert templates == covered, templates ^ covered


def test_two_profiles_with_the_same_history_do_not_leak(client):
    a_slug, _, xmpl = household(client, "Anna")
    reference = snapshot(client, a_slug, xmpl)
    assert reference["/investments/overview"]["kpis"]["value"]["total"] == 21459.0

    # an empty profile sees nothing of the first
    empty = client.post("/api/profiles", json={"name": "Pusty", "modules": ["investments"]}).json()[
        "slug"
    ]
    for path in INVESTMENTS_GETS:
        if "{instrument_id}" in path:
            r = client.get(f"/api/p/{empty}{path.format(instrument_id=xmpl)}")
            assert r.status_code == 404, path  # not an instrument of this profile
            continue
        r = client.get(f"/api/p/{empty}{path}")
        assert r.status_code == 200, (path, r.text)
    e = {p: client.get(f"/api/p/{empty}{p}").json() for p in INVESTMENTS_GETS if "{" not in p}
    assert (
        e["/investments/positions"]["positions"] == [] and e["/investments/positions"]["cash"] == []
    )
    assert e["/investments/overview"]["kpis"]["value"]["total"] == 0
    assert e["/investments/overview"]["kpis"]["last_run"] is None
    for path in (
        "/investments/transactions",
        "/investments/signals",
        "/investments/decisions",
        "/investments/instruments",
        "/investments/manual-valuations",
        "/investments/accounts",
        "/investments/imports",
        "/investments/reconciliation",
        "/investments/runs",
        "/investments/alerts",
        "/investments/watchlist",
    ):
        assert e[path] == [], path
    assert e["/investments/overview"]["attention"] == []
    assert e["/investments/strategy"]["state"] == "missing"
    digest = e["/investments/review-digest"]
    assert digest["imports"] == [] and digest["decisions"] == [] and digest["signals"]["new"] == []

    # the same history in a second profile: both see exactly the reference
    b_slug, _, b_xmpl = household(client, "Bartek")
    assert b_xmpl == xmpl  # instruments are shared reference data
    a_now, b_now = snapshot(client, a_slug, xmpl), snapshot(client, b_slug, xmpl)
    # the batch of the second import found the instruments already stored
    for snap in (a_now, b_now, reference):
        for batch in snap["/investments/imports"]:
            batch.pop("new_instruments")
        for batch in snap["/investments/review-digest"]["imports"]:
            batch.pop("new_instruments")
    assert a_now == reference
    assert b_now == reference

    # legacy aliases act on the default (oldest) profile
    for path in ("/investments/overview", "/investments/signals", "/investments/accounts"):
        assert client.get(f"/api{path}").json() == client.get(f"/api/p/{a_slug}{path}").json()


def test_writes_through_one_profile_never_touch_another(client):
    a_slug, a_aid, xmpl = household(client, "Anna")
    b_slug, b_aid, _ = household(client, "Bartek")
    # an instrument only Anna holds
    only = "1,txn,2026-01-20,,buy,T-8,ONLY,PLONLY000016,Only Anna SA,XWAR,1,10.00,PLN,10.00,,,-10.00,,,,"
    content = ("\n".join([HEADER, *ROWS, only]) + "\n").encode()
    preview = client.post(
        f"/api/p/{a_slug}/investments/import/preview",
        files={"file": ("a.csv", content, "text/csv")},
        data={"account_id": str(a_aid)},
    ).json()
    client.post(
        f"/api/p/{a_slug}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": "a.csv", "account_id": a_aid},
    )
    only_id = next(
        i["id"]
        for i in client.get(f"/api/p/{a_slug}/investments/instruments").json()
        if i["label"] == "ONLY"
    )
    reference = snapshot(client, b_slug, xmpl)

    a_signal = client.get(f"/api/p/{a_slug}/investments/signals").json()[0]["id"]
    a_thesis = client.get(f"/api/p/{a_slug}/investments/instruments/{xmpl}/theses").json()[0]["id"]
    b = f"/api/p/{b_slug}/investments"
    assert (
        client.post(f"{b}/signals/{a_signal}/decision", json={"action": "sold"}).status_code == 404
    )
    assert client.post(f"{b}/signals/{a_signal}/acknowledge", json={}).status_code == 404
    assert client.patch(f"{b}/theses/{a_thesis}", json={"thesis": "x"}).status_code == 404
    assert client.delete(f"{b}/theses/{a_thesis}").status_code == 404
    assert client.get(f"{b}/positions/{only_id}").status_code == 404
    assert client.get(f"{b}/instruments/{only_id}/theses").status_code == 404
    assert (
        client.post(
            f"{b}/instruments/{only_id}/theses", json={"entry_type": "trend", "thesis": "x"}
        ).status_code
        == 404
    )
    assert client.patch(f"{b}/instruments/{only_id}", json={"tags": ["x"]}).status_code == 404
    assert (
        client.post(
            f"{b}/manual-valuations", json={"instrument_id": only_id, "unit_value": "1"}
        ).status_code
        == 404
    )
    # alerts and the watchlist (F5)
    a_alert = client.get(f"/api/p/{a_slug}/investments/alerts").json()[0]["id"]
    a_item = client.get(f"/api/p/{a_slug}/investments/watchlist").json()[0]["id"]
    assert client.patch(f"{b}/alerts/{a_alert}", json={"title": "x"}).status_code == 404
    assert client.patch(f"{b}/alerts/{a_alert}", json={"status": "muted"}).status_code == 404
    assert client.delete(f"{b}/alerts/{a_alert}").status_code == 404
    assert client.patch(f"{b}/watchlist/{a_item}", json={"note": "x"}).status_code == 404
    assert client.delete(f"{b}/watchlist/{a_item}").status_code == 404
    only_alert = {
        "kind": "price_below",
        "params": {"level": 1},
        "instrument_id": only_id,
        "title": "x",
    }
    assert client.post(f"{b}/alerts", json=only_alert).status_code == 404
    assert client.post(f"{b}/watchlist", json={"instrument_id": only_id}).status_code == 404
    assert client.get(f"{b}/overview?accounts={a_aid}").status_code == 404
    assert client.get(f"{b}/transactions?account_id={a_aid}").status_code == 404
    assert client.get(f"{b}/reconciliation?account_id={a_aid}").status_code == 404
    assert (
        client.post(
            f"{b}/reconciliation/apply", json={"account_id": a_aid, "instrument_ids": [xmpl]}
        ).status_code
        == 404
    )
    r = client.post(
        f"{b}/import/preview",
        files={"file": ("x.csv", canonical_csv(), "text/csv")},
        data={"account_id": str(a_aid)},
    )
    assert r.status_code == 404
    r = client.post(
        f"{b}/signals/{a_signal}/decision", json={"action": "held", "account_id": a_aid}
    )
    assert r.status_code == 404
    # Anna's own writes after all that leave Bartek's view unchanged
    client.post(f"/api/p/{a_slug}/investments/signals/{a_signal}/decision", json={"action": "sold"})
    client.post(
        f"/api/p/{a_slug}/investments/manual-valuations",
        json={"instrument_id": xmpl, "unit_value": "1", "as_of": "2026-02-02"},
    )
    assert client.post(f"/api/p/{a_slug}/investments/alerts", json=only_alert).status_code == 201
    a_api = f"/api/p/{a_slug}/investments"
    assert client.patch(f"{a_api}/alerts/{a_alert}", json={"status": "muted"}).status_code == 200
    assert client.post(f"{a_api}/watchlist", json={"symbol_or_isin": "ONLYW.WA"}).status_code == 201
    assert client.delete(f"{a_api}/watchlist/{a_item}").status_code == 200
    assert client.post(f"{a_api}/run", json={}).status_code == 200
    assert snapshot(client, b_slug, xmpl) == reference
    assert b_aid != a_aid
