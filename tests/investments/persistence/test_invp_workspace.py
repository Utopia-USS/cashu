"""Workspace endpoints of the investments API: manual transactions (validation, instrument
resolution, dedup against later imports), the weekly review digest (default window and a baseline
from ``finanse.core.reviews``) and the position chart with rule threshold lines. Synthetic data only,
fake market sources, no live HTTP."""

from __future__ import annotations

import datetime as dt
import sys
import types
from decimal import Decimal

import pytest
from invp_support import AS_OF, HEADER, STRATEGY_YAML, canonical_csv, sources
from sqlmodel import select

from finanse.core.db import get_session
from finanse.core.models import Profile, utcnow
from finanse.modules.investments.domain import Currency, PriceBar
from finanse.modules.investments.models import InvInstrument
from finanse.modules.investments.service import daily, files, portfolio, views
from finanse.modules.investments.store import market


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def setup_profile(client, name: str = "Jan Inwestor") -> tuple[str, int]:
    r = client.post("/api/profiles", json={"name": name, "modules": ["investments"]})
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    r = client.post(f"/api/p/{slug}/investments/accounts", json={"name": "DIF", "broker": "dif"})
    assert r.status_code == 201, r.text
    return slug, r.json()["id"]


def preview(client, slug: str, account_id: int, content: bytes) -> dict:
    r = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("h.csv", content, "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def csv_of(*rows: str) -> bytes:
    return ("\n".join([HEADER, *rows]) + "\n").encode("utf-8")


def imported(client, name: str = "Jan Inwestor", strategy: str | None = STRATEGY_YAML):
    slug, aid = setup_profile(client, name)
    p = preview(client, slug, aid, canonical_csv())
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": p["file_id"], "file_name": "h.csv", "account_id": aid},
    )
    assert r.status_code == 201, r.text
    if strategy is not None:
        files.write_text_private(files.strategy_yaml_path(slug), strategy)
    return slug, aid


def instrument_id(client, slug: str, label: str) -> int:
    return next(
        i["id"]
        for i in client.get(f"/api/p/{slug}/investments/instruments").json()
        if i["label"] == label
    )


def manual(client, slug: str, **body):
    return client.post(f"/api/p/{slug}/investments/transactions", json=body)


# --------------------------------------------------------------------------- #
# Manual transactions
# --------------------------------------------------------------------------- #


def test_invp_manual_deposit_derives_cash(client):
    slug, aid = setup_profile(client)
    r = manual(
        client,
        slug,
        account_id=aid,
        type="deposit",
        trade_date="2026-02-03",
        gross_amount="1500.00",
        note="  Top-up  ",
    )
    assert r.status_code == 201, r.text
    body = r.json()
    txn = body["transaction"]
    assert (txn["type"], txn["cash_amount"], txn["cash_currency"], txn["currency"]) == (
        "deposit",
        1500.0,
        "PLN",
        "PLN",
    )
    assert txn["source"] == "manual" and txn["note"] == "Top-up"
    assert txn["account_id"] == aid and txn["account_name"] == "DIF"
    assert body["instrument"] is None and body["new_instrument"] is False
    assert body["warnings"] == []
    listed = client.get(f"/api/p/{slug}/investments/transactions").json()
    assert [t["id"] for t in listed] == [txn["id"]]
    assert client.get(f"/api/p/{slug}/investments/positions").json()["cash"][0]["amount"] == 1500.0


def test_invp_manual_buy_creates_instrument_by_symbol(client):
    slug, aid = setup_profile(client)
    r = manual(
        client,
        slug,
        account_id=aid,
        type="buy",
        trade_date="2026-02-04",
        instrument={"symbol": "NEWCO", "name": "New Company SA", "exchange": "XWAR"},
        quantity=10,
        price="25.00",
        fee=1,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    inst = body["instrument"]
    assert body["new_instrument"] is True
    assert (inst["symbol"], inst["name"], inst["mic"], inst["currency"]) == (
        "NEWCO",
        "New Company SA",
        "XWAR",
        "PLN",
    )
    assert inst["needs_classification"] is True and inst["asset_class"] == "other"
    assert inst["aliases"] == []
    txn = body["transaction"]
    assert (txn["gross_amount"], txn["fee"], txn["cash_amount"]) == (250.0, 1.0, -251.0)
    assert txn["instrument_id"] == inst["id"]
    unclassified = client.get(f"/api/p/{slug}/investments/instruments?unclassified=true").json()
    assert [i["label"] for i in unclassified] == ["NEWCO"]

    # the same ticker again (any case) is the instrument the profile already references
    again = manual(
        client,
        slug,
        account_id=aid,
        type="sell",
        trade_date="2026-02-05",
        instrument={"symbol": "newco"},
        quantity=4,
        price=30,
    ).json()
    assert again["new_instrument"] is False and again["instrument"]["id"] == inst["id"]
    assert again["transaction"]["cash_amount"] == 120.0

    # a described ISIN finds the stored instrument; an unknown one creates it with an ISIN alias
    by_isin = manual(
        client,
        slug,
        account_id=aid,
        type="buy",
        trade_date="2026-02-06",
        instrument={
            "symbol": "ISN",
            "isin": "pl0000000099",
            "currency": "EUR",
            "asset_class": "etf",
        },
        quantity=1,
        price=10,
        cash_amount=-43,
        cash_currency="PLN",
    ).json()
    created = by_isin["instrument"]
    assert by_isin["new_instrument"] is True and created["isin"] == "PL0000000099"
    assert created["currency"] == "EUR" and created["asset_class"] == "etf"
    assert {"namespace": "isin", "value": "PL0000000099", "guessed": False} in created["aliases"]
    assert by_isin["transaction"]["currency"] == "EUR"
    assert by_isin["transaction"]["cash_currency"] == "PLN"
    found = manual(
        client,
        slug,
        account_id=aid,
        type="dividend",
        trade_date="2026-02-07",
        instrument={"isin": "PL0000000099"},
        cash_amount="0.50",
    ).json()
    assert found["new_instrument"] is False and found["instrument"]["id"] == created["id"]
    assert found["transaction"]["currency"] == "EUR"  # the instrument's currency


def test_invp_manual_buy_of_existing_instrument_by_id(client):
    slug, aid = imported(client, strategy=None)
    xmpl = instrument_id(client, slug, "XMPL")
    r = manual(
        client,
        slug,
        account_id=aid,
        type="buy",
        trade_date="2026-02-10",
        instrument_id=xmpl,
        quantity="5",
        price="100",
        cash_currency="PLN",
        fx_rate="4.0",
    )
    assert r.status_code == 201, r.text
    body = r.json()
    txn = body["transaction"]
    assert body["new_instrument"] is False and body["instrument"]["label"] == "XMPL"
    assert (txn["currency"], txn["gross_amount"], txn["cash_amount"], txn["cash_currency"]) == (
        "USD",
        500.0,
        -2000.0,
        "PLN",
    )
    positions = client.get(f"/api/p/{slug}/investments/positions").json()["positions"]
    row = next(p for p in positions if p["instrument"]["id"] == xmpl)
    assert row["quantity"] == 25.0
    # a cross-currency trade without a rate or cash amount cannot be derived
    r = manual(
        client,
        slug,
        account_id=aid,
        type="buy",
        trade_date="2026-02-10",
        instrument_id=xmpl,
        quantity=1,
        price=100,
        cash_currency="PLN",
    )
    assert r.status_code == 422 and "fx_rate" in r.json()["detail"]


def test_invp_manual_dividend_with_negative_cash_warns(client):
    slug, aid = imported(client, strategy=None)
    xmpl = instrument_id(client, slug, "XMPL")
    r = manual(
        client,
        slug,
        account_id=aid,
        type="dividend",
        trade_date="2026-02-12",
        instrument_id=xmpl,
        cash_amount="-3.00",
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["transaction"]["cash_amount"] == -3.0
    assert body["transaction"]["currency"] == "USD"
    (warning,) = body["warnings"]
    assert "negative" in warning and "dividend" in warning
    fee = manual(
        client, slug, account_id=aid, type="fee", trade_date="2026-02-12", fee="2.5"
    ).json()
    assert fee["transaction"]["cash_amount"] == -2.5 and fee["warnings"] == []


def test_invp_manual_transaction_errors(client):
    slug, aid = imported(client, strategy=None)
    xmpl = instrument_id(client, slug, "XMPL")
    before = len(client.get(f"/api/p/{slug}/investments/transactions").json())
    base = {"account_id": aid, "trade_date": "2026-02-14"}

    def detail(**body) -> str:
        r = manual(client, slug, **{**base, **body})
        assert r.status_code == 422, (body, r.status_code, r.text)
        return r.json()["detail"]

    assert "Unknown type" in detail(type="gift", cash_amount=1)
    assert "needs an instrument" in detail(type="buy", quantity=1, price=10)
    assert "must not have an instrument" in detail(
        type="deposit", cash_amount=100, instrument={"symbol": "ABC"}
    )
    assert "cash_amount <= 0" in detail(
        type="buy", instrument_id=xmpl, quantity=1, price=10, cash_amount=10
    )
    assert "split_ratio" in detail(type="split", instrument_id=xmpl)
    assert "split_ratio" in detail(
        type="buy", instrument_id=xmpl, quantity=1, price=1, split_ratio=2
    )
    assert "quantity > 0" in detail(type="sell", instrument_id=xmpl, price=10)
    assert "must not have a quantity" in detail(type="deposit", cash_amount=10, quantity=1)
    assert "deposit needs a cash_amount >= 0" in detail(type="deposit", cash_amount=-10)
    assert "no cash effect" in detail(
        type="transfer_in", instrument_id=xmpl, quantity=1, cash_amount=-5
    )
    assert "fx_conversion" in detail(type="fx_conversion")
    assert "equal" in detail(
        type="fx_conversion", currency="PLN", cash_currency="USD", cash_amount=-400
    )
    assert ">= 0" in detail(type="buy", instrument_id=xmpl, quantity=1, price=-1)
    assert "fx_rate" in detail(type="deposit", cash_amount=1, fx_rate=0)
    assert "currency" in detail(type="deposit", cash_amount=1, currency="ZŁOTY")
    assert "number" in detail(type="deposit", cash_amount="lots")
    assert "ISIN" in detail(type="buy", quantity=1, price=1, instrument={"isin": "nope"})
    assert "asset_class" in detail(
        type="buy", quantity=1, price=1, instrument={"symbol": "GHOST", "asset_class": "stonks"}
    )
    assert "no amount" in detail(type="interest")
    # a failed entry never creates its instrument
    detail(type="buy", quantity=1, price=1, cash_amount=5, instrument={"symbol": "GHOST"})
    with get_session() as s:
        assert s.exec(select(InvInstrument).where(InvInstrument.symbol == "GHOST")).first() is None

    # another profile's account and instrument are not found
    other_slug, other_aid = setup_profile(client, "Druga Osoba")
    only = manual(
        client,
        other_slug,
        account_id=other_aid,
        type="buy",
        trade_date="2026-02-14",
        instrument={"symbol": "ONLYB", "name": "Only B SA"},
        quantity=1,
        price=10,
    ).json()["instrument"]["id"]
    r = manual(
        client, slug, account_id=other_aid, type="deposit", trade_date="2026-02-14", cash_amount=1
    )
    assert r.status_code == 404
    r = manual(client, slug, **base, type="buy", instrument_id=only, quantity=1, price=10)
    assert r.status_code == 404
    r = manual(
        client,
        other_slug,
        **{**base, "account_id": other_aid},
        type="dividend",
        instrument_id=xmpl,
        cash_amount=1,
    )
    assert r.status_code == 404
    assert len(client.get(f"/api/p/{slug}/investments/transactions").json()) == before


def test_invp_manual_duplicates_store_and_a_later_import_recognizes_them(client):
    slug, aid = setup_profile(client)
    entry = {
        "account_id": aid,
        "type": "deposit",
        "trade_date": "2026-02-03",
        "cash_amount": "1500",
    }
    first = manual(client, slug, **entry)
    second = manual(client, slug, **entry)
    assert first.status_code == second.status_code == 201
    assert first.json()["transaction"]["id"] != second.json()["transaction"]["id"]
    assert len(client.get(f"/api/p/{slug}/investments/transactions").json()) == 2

    # the same deposit in an export without external_ref: two copies are known, a third is new
    row = "1,txn,2026-02-03,,deposit,,,,,,,,PLN,,,,1500.00,,,,"
    p = preview(client, slug, aid, csv_of(row, row, row))
    assert p["can_commit"], p["errors"]
    assert (p["counts"]["duplicates"], p["counts"]["new"]) == (2, 1)
    single = preview(client, slug, aid, csv_of(row))
    assert (single["counts"]["duplicates"], single["counts"]["new"]) == (1, 0)


# --------------------------------------------------------------------------- #
# Review digest
# --------------------------------------------------------------------------- #


def run(client, slug: str) -> None:
    r = client.post(f"/api/p/{slug}/investments/run", json={})
    assert r.status_code == 200, r.text


def set_close(instrument: int, day: dt.date, close: str, currency: str = "USD") -> None:
    with get_session() as s:
        market.upsert_bars(
            s,
            [
                PriceBar(
                    instrument_id=str(instrument),
                    date=day,
                    close=Decimal(close),
                    source="yahoo",
                    currency=Currency(currency),
                )
            ],
            now=utcnow(),
        )


def test_invp_review_digest_default_window(client, monkeypatch):
    slug, aid = imported(client)
    run(client, slug)
    (sig,) = client.get(f"/api/p/{slug}/investments/signals").json()
    xmpl = sig["instrument_id"]
    empty = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert empty["signals"]["undecided"] == 1
    client.post(f"/api/p/{slug}/investments/signals/{sig['id']}/decision", json={"action": "held"})
    manual(client, slug, account_id=aid, type="deposit", trade_date="2026-02-25", cash_amount=1000)
    manual(
        client,
        slug,
        account_id=aid,
        type="dividend",
        trade_date="2026-02-26",
        instrument_id=xmpl,
        cash_amount=2,
    )
    set_close(xmpl, AS_OF, "110")
    now = dt.datetime(2026, 3, 1, 12, tzinfo=dt.UTC)
    monkeypatch.setattr(views, "utcnow", lambda: now)

    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["as_of"] == AS_OF.isoformat() and d["since"] == "2026-02-22"
    assert d["baseline"] == "default_7d" and d["last_review"] is None
    assert d["until_at"].startswith("2026-03-01T12:00") and d["since_at"].startswith("2026-02-22")
    assert d["digest_weekday"] == "sunday" and d["review_due"] is True
    value = d["value"]
    # then: the synthetic history at 2026-02-22; now: + deposit 1000, dividend 2 USD, XMPL +10 USD x 20
    assert value["currency"] == "PLN" and value["then"] == pytest.approx(21459.0)
    assert value["now"] == pytest.approx(21459.0 + 1000 + 2 * 4.0 + 20 * 10 * 4.0)
    assert value["change"] == pytest.approx(value["now"] - value["then"])
    assert value["change_pct"] == pytest.approx(value["change"] / value["then"], rel=1e-4)
    signals = d["signals"]
    assert [s["rule_id"] for s in signals["new"]] == ["concentration"]
    assert signals["new"][0]["instrument_label"] == "XMPL"
    assert signals["new"][0]["decisions"][0]["action"] == "held"
    assert signals["escalated"] == [] and signals["resolved"] == []
    assert (signals["open"], signals["undecided"]) == (1, 0)
    (batch,) = d["imports"]
    assert batch["account_name"] == "DIF" and batch["inserted"] == 5
    assert d["transactions"] == {
        "count": 7,
        "by_type": {"buy": 3, "deposit": 2, "dividend": 2},
        "manual": 2,
    }
    assert [x["action"] for x in d["decisions"]] == ["held"]
    assert d["dividends"] == {"USD": 2.0}  # the January dividend is before the window
    (move,) = d["price_moves"]
    assert (move["label"], move["from"], move["to"], move["to_date"]) == (
        "XMPL",
        100.0,
        110.0,
        AS_OF.isoformat(),
    )
    assert move["from_date"] <= "2026-02-22" and move["change_pct"] == pytest.approx(0.1)
    assert d["stale_count"] == 0 and isinstance(d["warnings"], list)
    assert d["strategy"] == {"version": 1, "state": "valid", "changed_since": True}


def fake_reviews(monkeypatch, last) -> None:
    module = types.ModuleType("finanse.core.reviews")
    module.last = last
    monkeypatch.setitem(sys.modules, "finanse.core.reviews", module)


def test_invp_review_digest_uses_the_last_review(client, monkeypatch):
    slug, aid = imported(client)
    run(client, slug)
    calls = []

    # a review long before: the baseline is the review, everything since is listed
    def early(profile, module):
        calls.append((profile.slug, module))
        return {
            "done_at": dt.datetime(2026, 2, 20, 12, tzinfo=dt.UTC),
            "notes": "All fine",
            "stats": {"open": 0},
        }

    fake_reviews(monkeypatch, early)
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert calls == [(slug, "investments")]
    assert d["baseline"] == "review" and d["since"] == "2026-02-20"
    assert d["last_review"] == {
        "done_at": "2026-02-20T12:00:00+00:00",
        "notes": "All fine",
        "stats": {"open": 0},
    }
    assert d["since_at"] == "2026-02-20T12:00:00+00:00"
    assert d["review_due"] is True  # Sunday 2026-03-01 is after the review
    assert len(d["imports"]) == 1 and len(d["signals"]["new"]) == 1

    # a review just now (another signature, an object record): the window moves past the import
    done = utcnow()

    def recent(session, profile_id, module):
        assert isinstance(profile_id, int) and module == "investments"
        return types.SimpleNamespace(done_at=done.replace(tzinfo=None), notes=None, stats=None)

    fake_reviews(monkeypatch, recent)
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["baseline"] == "review" and d["review_due"] is False
    assert d["last_review"]["notes"] is None and d["last_review"]["stats"] == {}
    assert d["since"] == AS_OF.isoformat()  # never after as_of
    assert d["imports"] == [] and d["signals"]["new"] == [] and d["decisions"] == []
    assert d["transactions"]["count"] == 0
    assert d["signals"]["open"] == 1 and d["signals"]["undecided"] == 1
    assert d["strategy"]["changed_since"] is False
    manual(client, slug, account_id=aid, type="deposit", trade_date="2026-03-02", cash_amount=5)
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["transactions"] == {"count": 1, "by_type": {"deposit": 1}, "manual": 1}

    # a broken reviews module means no review
    def broken(*_args):
        raise RuntimeError("database is busy")

    fake_reviews(monkeypatch, broken)
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["baseline"] == "default_7d" and d["last_review"] is None and d["review_due"] is True


def test_invp_review_digest_of_an_empty_profile(client):
    full, _ = imported(client, "Pełny Profil")
    run(client, full)
    assert client.get(f"/api/p/{full}/investments/review-digest").json()["imports"]
    slug, _ = setup_profile(client)
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["transactions"] == {"count": 0, "by_type": {}, "manual": 0}
    assert d["decisions"] == [] and d["warnings"] == [] and d["stale_count"] == 0
    assert d["value"] == {
        "currency": "PLN",
        "then": None,
        "now": 0.0,
        "change": None,
        "change_pct": None,
        "contributions": None,
        "transfers": None,
        "implied_funding": None,
        "market_change": None,
        "market_change_pct": None,
    }
    assert d["signals"] == {"new": [], "escalated": [], "resolved": [], "open": 0, "undecided": 0}
    assert d["imports"] == [] and d["price_moves"] == [] and d["dividends"] == {}
    assert d["strategy"] == {"version": None, "state": "missing", "changed_since": False}


# --------------------------------------------------------------------------- #
# Position chart
# --------------------------------------------------------------------------- #

CHART_STRATEGY = (
    STRATEGY_YAML
    + """\
  - id: dip
    kind: drawdown_from_high
    params: { threshold: 0.15, window_days: 20 }
  - id: stop_loss
    kind: loss_from_cost
    params: { threshold: 0.25 }
  - id: take_profit
    kind: gain_from_cost
    params: { threshold: 0.5 }
  - id: bond_dip
    kind: drawdown_from_high
    params: { threshold: 0.05, asset_class: [bond] }
"""
)


def test_invp_position_chart(client):
    slug, aid = imported(client, strategy=CHART_STRATEGY)
    run(client, slug)
    xmpl = instrument_id(client, slug, "XMPL")
    set_close(xmpl, dt.date(2026, 2, 16), "120")

    c = client.get(f"/api/p/{slug}/investments/positions/{xmpl}/chart").json()
    assert (c["instrument_id"], c["label"], c["currency"], c["valuation_mode"]) == (
        xmpl,
        "XMPL",
        "USD",
        "market",
    )
    assert c["as_of"] == AS_OF.isoformat()
    assert c["series"] and all(p["date"] >= "2024-03-02" for p in c["series"])
    assert c["last"] == {"date": AS_OF.isoformat(), "close": 100.0}
    assert c["high_52w"] == 120.0
    assert c["cost"] == {"average": 100.0, "currency": "USD"}
    lines = {t["rule_id"]: t for t in c["thresholds"]}
    assert set(lines) == {"dip", "stop_loss", "take_profit"}  # bond_dip filters XMPL out
    assert lines["dip"] == {
        "rule_id": "dip",
        "kind": "drawdown_from_high",
        "threshold": 0.15,
        "basis": "high",
        "window_days": 20,
        "y": pytest.approx(120 * 0.85),
    }
    assert (lines["stop_loss"]["basis"], lines["stop_loss"]["y"]) == ("cost", 75.0)
    assert (lines["take_profit"]["window_days"], lines["take_profit"]["y"]) == (None, 150.0)
    assert c["markers"] == [
        {
            "date": "2026-01-14",
            "type": "buy",
            "quantity": 20.0,
            "price": 100.0,
            "currency": "USD",
            "account_id": aid,
        }
    ]

    short = client.get(f"/api/p/{slug}/investments/positions/{xmpl}/chart?months=1").json()
    assert short["series"] and all(p["date"] >= "2026-02-02" for p in short["series"])
    assert short["markers"] == [] and short["high_52w"] == 120.0
    for months in (0, 121):
        r = client.get(f"/api/p/{slug}/investments/positions/{xmpl}/chart?months={months}")
        assert r.status_code == 422
    other, _ = setup_profile(client, "Obca Osoba")
    assert client.get(f"/api/p/{other}/investments/positions/{xmpl}/chart").status_code == 404

    # bucket match criteria for classifying into a bucket
    facts = client.get(f"/api/p/{slug}/investments/strategy").json()["facts"]
    assert facts["bucket_matches"] == [
        {
            "id": "stocks",
            "asset_class": ["equity", "etf"],
            "tags": [],
            "mic": [],
            "currency": [],
            "instrument_ids": [],
        },
        {
            "id": "cash",
            "asset_class": ["cash"],
            "tags": [],
            "mic": [],
            "currency": [],
            "instrument_ids": [],
        },
    ]


def test_invp_position_chart_without_holding_or_strategy(client):
    slug, aid = imported(client, strategy=None)
    xmpl = instrument_id(client, slug, "XMPL")
    manual(
        client,
        slug,
        account_id=aid,
        type="sell",
        trade_date="2026-02-20",
        instrument_id=xmpl,
        quantity=20,
        price=100,
    )
    c = client.get(f"/api/p/{slug}/investments/positions/{xmpl}/chart").json()
    assert c["cost"] is None and c["thresholds"] == []
    assert [m["type"] for m in c["markers"]] == ["buy", "sell"]
    assert c["series"] == [] and c["last"] is None and c["high_52w"] is None
    assert c["currency"] == "USD"  # no bars yet: the instrument's currency


def test_invp_review_digest_with_the_core_reviews_module(client):
    reviews = pytest.importorskip("finanse.core.reviews")
    slug, _ = imported(client)
    run(client, slug)
    with get_session() as s:
        profile = s.exec(select(Profile).where(Profile.slug == slug)).one()
        reviews.mark_done(s, profile.id, "investments", notes="Weekly check", stats={"open": 1})
    d = client.get(f"/api/p/{slug}/investments/review-digest").json()
    assert d["baseline"] == "review" and d["last_review"]["notes"] == "Weekly check"
    assert d["last_review"]["stats"] == {"open": 1}
    assert d["imports"] == [] and d["signals"]["new"] == []
