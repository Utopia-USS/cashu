"""Per-profile instrument attributes (F5 review R2): what one profile changes about a shared instrument
(status incl. frozen, name, classification, valuation mode, import delistings) never changes another
profile's valuation, names, lists, refresh or MCP privacy decisions."""

from __future__ import annotations

import pytest
from invp_support import AS_OF, HEADER, ROWS, FakePrices, sources
from test_al_api import household, ids

from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.modules.investments.models import InvInstrument
from cashu.modules.investments.service import daily, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def view(client, slug: str) -> dict:
    base = f"/api/p/{slug}/investments"
    return {
        "total": client.get(f"{base}/overview").json()["kpis"]["value"]["total"],
        "instruments": {
            i["symbol"]: (i["name"], i["status"], i["asset_class"], i["tags"], i["valuation_mode"])
            for i in client.get(f"{base}/instruments").json()
        },
        "positions": [
            (p["instrument"]["name"], p["value"], p["valuation_mode"])
            for p in client.get(f"{base}/positions").json()["positions"]
        ],
    }


def test_one_profile_classifying_a_shared_instrument_leaves_the_other_unchanged(client):
    a, _ = household(client, "Anna")
    b, _ = household(client, "Bartek")
    for slug in (a, b):
        client.post(f"/api/p/{slug}/investments/run", json={})
    b_before = view(client, b)
    assert b_before["total"] == 21459.0
    xmpl = ids(client, a)["XMPL"]
    r = client.patch(
        f"/api/p/{a}/investments/instruments/{xmpl}",
        json={
            "status": "frozen",
            "name": "Anna private label",
            "tags": ["private"],
            "region": "",
        },
    )
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["status"], r.json()["tags"]) == (
        "Anna private label",
        "frozen",
        ["private"],
    )
    abc = ids(client, a)["ABC"]
    client.patch(f"/api/p/{a}/investments/instruments/{abc}", json={"valuation_mode": "cost"})

    a_now, b_now = view(client, a), view(client, b)
    assert b_now == b_before  # Bartek's total, names, classification and positions
    assert a_now["total"] != b_now["total"]  # Anna's frozen XMPL (and ABC at cost) changed hers
    assert a_now["instruments"]["XMPL"][:2] == ("Anna private label", "frozen")
    assert a_now["instruments"]["ABC"][4] == "cost"
    with get_session() as s:  # the shared row keeps the market identity and defaults
        row = s.get(InvInstrument, xmpl)
        assert (row.name, row.status, row.tags) == ("Example Corp", "active", [])

    # one daily run for both: Bartek still needs XMPL prices, so it is fetched
    fake = FakePrices()
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))
    assert "XMPL" in {symbol for symbol, _start, _end in fake.calls}
    assert view(client, b)["total"] == 21459.0


def test_an_import_delisting_is_the_importing_profiles_view(client):
    a, a_aid = household(client, "Anna")
    b, _ = household(client, "Bartek")
    header = HEADER + ",new_symbol,new_isin,new_name,frozen"
    rows = [r + ",,,," for r in ROWS] + [
        "1,delisting,2026-02-20,,,,XMPL,US0000000001,,XNAS,,,,,,,,,,,,,,,true",
    ]
    content = ("\n".join([header, *rows]) + "\n").encode()
    preview = client.post(
        f"/api/p/{a}/investments/import/preview",
        files={"file": ("d.csv", content, "text/csv")},
        data={"account_id": str(a_aid)},
    ).json()
    client.post(
        f"/api/p/{a}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": "d.csv", "account_id": a_aid},
    )
    assert view(client, a)["instruments"]["XMPL"][1] == "frozen"
    assert view(client, b)["instruments"]["XMPL"][1] == "active"


def test_mcp_owner_named_decision_follows_the_profile(client):
    a, _ = household(client, "Anna")
    b, _ = household(client, "Bartek")
    xmpl = ids(client, a)["XMPL"]
    client.patch(
        f"/api/p/{a}/investments/instruments/{xmpl}",
        json={"asset_class": "claim", "name": "Pozyczka Jan Kowalski", "valuation_mode": "manual"},
    )
    from sqlmodel import select

    from cashu.core.models import Profile

    with get_session() as s:
        pid = {p.slug: p.id for p in s.exec(select(Profile)).all()}
    a_rows = CashuMcp(pid[a], today=AS_OF).call("positions", {}).data["positions"]
    b_rows = CashuMcp(pid[b], today=AS_OF).call("positions", {}).data["positions"]
    a_x = next(r for r in a_rows if r.get("instrument_id") == xmpl)
    b_x = next(r for r in b_rows if r.get("instrument_id") == xmpl)
    assert a_x["owner_named"] is True and "name" not in a_x and "symbol" not in a_x
    assert b_x["owner_named"] is False and b_x["symbol"] == "XMPL"
    assert "Kowalski" not in str(CashuMcp(pid[a], today=AS_OF).call("theses", {}).data)
