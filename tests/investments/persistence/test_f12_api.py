"""F12 endpoints and MCP tools: ``GET /instruments/search`` (shape, states, remote status, 422), ``POST
/watchlist`` with a search ``pick`` and the ``restored`` flag, ``DELETE`` keeping the entry (asset page
still 200, ``entry`` state saved), the MCP ``search_instruments`` tool and ``add_to_watchlist`` /
``remove_from_watchlist`` on the soft model. Synthetic portfolio; recorded remote answers."""

from __future__ import annotations

import pytest
from f12_support import Recorded, install
from invp_support import AS_OF, sources
from sqlmodel import select
from test_al_api import household, ids

from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile
from cashu.modules.investments.service import daily, portfolio

HIT_KEYS = {
    "key",
    "instrument_id",
    "state",
    "symbol",
    "yahoo_symbol",
    "name",
    "exchange",
    "mic",
    "asset_class",
    "currency",
    "isin",
    "source",
}


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def test_search_endpoint_shape_and_errors(client, monkeypatch):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    install(monkeypatch)
    r = client.get(f"{base}/instruments/search", params={"q": "VWCE"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data) == {"query", "local", "remote", "remote_status"}
    assert (data["query"], data["remote_status"], data["local"]) == ("VWCE", "ok", [])
    first = data["remote"][0]
    assert set(first) == HIT_KEYS
    assert first == {
        "key": "y:VWCE.DE",
        "instrument_id": None,
        "state": "new",
        "symbol": "VWCE",
        "yahoo_symbol": "VWCE.DE",
        "name": "Vanguard FTSE All-World UCITS ETF USD Accumulation",
        "exchange": "XETRA",
        "mic": "XETR",
        "asset_class": "etf",
        "currency": "EUR",
        "isin": None,
        "source": "yahoo",
    }
    local = client.get(f"{base}/instruments/search", params={"q": "xmpl", "remote": 0}).json()
    assert local["remote_status"] == "skipped"
    (xmpl,) = local["local"]
    assert set(xmpl) == HIT_KEYS
    assert (xmpl["state"], xmpl["source"], xmpl["key"]) == (
        "held",
        "local",
        f"i:{xmpl['instrument_id']}",
    )
    for bad in ("", "x" * 61):
        r = client.get(f"{base}/instruments/search", params={"q": bad})
        assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "search_invalid"
    install(monkeypatch, Recorded(search_down=True))
    down = client.get(f"{base}/instruments/search", params={"q": "examp"}).json()
    assert down["remote_status"] == "unavailable" and down["remote"] == []
    assert {h["symbol"] for h in down["local"]} == {"ABC", "XMPL"}


def test_pick_add_remove_and_restore_over_the_api(client, monkeypatch):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    install(monkeypatch)
    hit = client.get(f"{base}/instruments/search", params={"q": "IE00BK5BQT80"}).json()["remote"][0]
    pick = {k: hit[k] for k in ("name", "asset_class", "mic", "isin")} | {
        "yahoo_symbol": hit["yahoo_symbol"],
        "ticker": hit["symbol"],
    }
    r = client.post(f"{base}/watchlist", json={"pick": pick, "tags": ["etf"]})
    assert r.status_code == 201, r.text
    item = r.json()
    assert (item["created_instrument"], item["restored"], item["warnings"]) == (True, False, [])
    assert item["warning_codes"] == []
    inst = item["instrument"]
    assert (inst["symbol"], inst["currency"], inst["mic"], inst["isin"]) == (
        "VWRA",
        "USD",
        "XLON",
        "IE00BK5BQT80",
    )
    assert {"namespace": "yahoo", "value": "VWRA.L", "guessed": False} in inst["aliases"]
    assert item["price"] is not None and item["closes_30d"]  # bars stored at once
    vwra = item["instrument_id"]

    # removed: gone from the list, the entry stays (asset page, search state saved)
    assert client.delete(f"{base}/watchlist/{item['id']}").json() == {"deleted": item["id"]}
    assert client.delete(f"{base}/watchlist/{item['id']}").status_code == 404
    assert vwra not in {r["instrument_id"] for r in client.get(f"{base}/watchlist").json()}
    detail = client.get(f"{base}/positions/{vwra}")
    assert detail.status_code == 200
    assert detail.json()["entry"] == {"state": "saved", "watch_item_id": None}
    again = client.get(f"{base}/instruments/search", params={"q": "VWRA", "remote": 0}).json()
    assert [(h["instrument_id"], h["state"]) for h in again["local"]] == [(vwra, "saved")]

    # the same pick restores the same row, tags kept
    r = client.post(f"{base}/watchlist", json={"pick": {"yahoo_symbol": "VWRA.L"}})
    restored = r.json()
    assert r.status_code == 201 and restored["restored"] is True
    assert (restored["id"], restored["tags"], restored["created_instrument"]) == (
        item["id"],
        ["etf"],
        False,
    )
    detail = client.get(f"{base}/positions/{vwra}").json()
    assert detail["entry"] == {"state": "watched", "watch_item_id": item["id"]}
    xmpl = ids(client, slug)["XMPL"]
    assert client.get(f"{base}/positions/{xmpl}").json()["entry"]["state"] == "held"
    conflict = client.post(f"{base}/watchlist", json={"pick": {"yahoo_symbol": "VWRA.L"}})
    assert conflict.status_code == 409

    # by instrument id after another removal (undo in the UI)
    client.delete(f"{base}/watchlist/{item['id']}")
    undo = client.post(f"{base}/watchlist", json={"instrument_id": vwra}).json()
    assert (undo["id"], undo["restored"]) == (item["id"], True)


def test_post_takes_exactly_one_way_to_name_the_instrument(client, monkeypatch):
    slug, _ = household(client)
    base = f"/api/p/{slug}/investments"
    install(monkeypatch, Recorded(chart_down=True))
    for body in (
        {},
        {"symbol_or_isin": "VWCE.DE", "pick": {"yahoo_symbol": "VWCE.DE"}},
        {"instrument_id": 1, "symbol_or_isin": "VWCE.DE"},
    ):
        r = client.post(f"{base}/watchlist", json=body)
        assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "watchlist_invalid"
    assert client.post(f"{base}/watchlist", json={"pick": {}}).status_code == 422
    assert (
        client.post(f"{base}/watchlist", json={"pick": {"yahoo_symbol": "X", "x": 1}}).status_code
        == 422
    )
    r = client.post(f"{base}/watchlist", json={"pick": {"yahoo_symbol": "NVDA"}})
    assert r.status_code == 201
    assert r.json()["warning_codes"] == [
        {
            "code": "watchlist.unverified_price_symbol",
            "params": {"symbol": "NVDA"},
            "message": r.json()["warnings"][0],
        }
    ]
    assert r.json()["instrument"]["currency"] == "USD"


def test_mcp_search_and_restore(client, monkeypatch):
    slug, _ = household(client)
    install(monkeypatch)
    with get_session() as s:
        pid = s.exec(select(Profile.id).where(Profile.slug == slug)).one()
    mcp = CashuMcp(pid)
    found = mcp.call("search_instruments", {"query": "orlen"})
    assert found.ok, found.error
    assert found.data["remote_status"] == "ok"
    first = found.data["remote"][0]
    assert (first["yahoo_symbol"], first["state"], first["exchange"], first["mic"]) == (
        "PKN.WA",
        "new",
        "WSE",
        "XWAR",
    )
    assert first["name"] == "Orlen S.A." and first["instrument_id"] is None
    local = mcp.call("search_instruments", {"query": "XMPL"}).data["local"]
    assert [(h["symbol"], h["state"]) for h in local] == [("XMPL", "held")]
    assert mcp.call("search_instruments", {"query": ""}).ok is False

    added = mcp.call("add_to_watchlist", {"symbol_or_isin": "PKN.WA", "note": "idea"})
    assert added.ok and added.data["restored"] is False
    item_id = added.data["item"]["item_id"]
    removed = mcp.call("remove_from_watchlist", {"id": item_id})
    assert removed.ok and removed.data == {"item_id": item_id, "removed": True}
    assert mcp.call("watchlist", {}).data["items"] == []
    state = mcp.call("search_instruments", {"query": "PKN"}).data["local"]
    assert [(h["symbol"], h["state"]) for h in state] == [("PKN", "saved")]
    again = mcp.call("add_to_watchlist", {"symbol_or_isin": "PKN.WA"})
    assert again.data["restored"] is True and again.data["item"]["item_id"] == item_id
    assert again.data["item"]["note"] == "idea"


def test_mcp_search_never_matches_hidden_names_or_exposes_other_profiles(client, monkeypatch):
    from cashu.modules.investments.domain import AssetClass, Currency, Instrument
    from cashu.modules.investments.service import watchlist as watch
    from cashu.modules.investments.store import instruments, journal

    slug, _ = household(client)
    other, _ = household(client, "Bartek")
    install(monkeypatch)
    with get_session() as s:
        pid = s.exec(select(Profile.id).where(Profile.slug == slug)).one()
        oid = s.exec(select(Profile.id).where(Profile.slug == other)).one()
        claim = instruments.insert(
            s,
            Instrument(
                id="c",
                name="Pozyczka Zielinski",
                currency=Currency.PLN,
                asset_class=AssetClass.CLAIM,
                symbol="PZ1",
            ),
        ).id
        journal.create_thesis(s, pid, claim, {"entry_type": "trend", "thesis": "Prywatna"})
        watch.add(s, s.get(Profile, oid), pick=watch.SearchPick("VWCE.DE"))
    mcp = CashuMcp(pid)
    # the owner-named instrument's name is redacted, so it is never matched by name
    assert mcp.call("search_instruments", {"query": "Zielin"}).data["local"] == []
    by_symbol = mcp.call("search_instruments", {"query": "PZ1"}).data["local"]
    assert [h["state"] for h in by_symbol] == ["saved"] and "name" not in by_symbol[0]
    # the app (API) still matches the owner's own names
    api = client.get(f"/api/p/{slug}/investments/instruments/search", params={"q": "Zielin"})
    assert [h["instrument_id"] for h in api.json()["local"]] == [claim]
    # Bartek's VWCE.DE: a plain listing for Anna, no instrument id
    hit = next(
        h
        for h in mcp.call("search_instruments", {"query": "VWCE"}).data["remote"]
        if h["yahoo_symbol"] == "VWCE.DE"
    )
    assert (hit["instrument_id"], hit["key"], hit["state"]) == (None, "y:VWCE.DE", "new")
