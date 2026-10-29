"""Market segments (P5) against a real DB and the API: the instrument segment (PATCH, auto, clearing,
reviewed flag untouched), ``GET /research/segments`` (shape, windows, a segment with a note and no
exposure, residual null on an incomplete series and 0 on a flat complete one), segment notes (no
instrument, one per segment and ISO week incl. dismissed, duplicate scope, signal key and payload,
``segment`` filter, read marks), the weekly run's novelty limits and the review digest block.
Synthetic data only."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import (
    STRATEGY_YAML,
    add_account,
    canonical_csv,
    distinct_words,
    import_file,
    make_profile,
    sources,
)
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.models import InvInstrument, InvSignal
from cashu.modules.investments.research import service, views
from cashu.modules.investments.research.validation import (
    SEGMENT_ONLY,
    RunScope,
    validate_note,
)
from cashu.modules.investments.service import daily, files
from cashu.modules.investments.service import watchlist as watch_service
from cashu.modules.investments.store import journal


def setup_investor(name: str = "Badacz") -> tuple[int, str]:
    pid, slug = make_profile(name)
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


@pytest.fixture
def investor(db_engine):
    return setup_investor()


@pytest.fixture
def api(api_empty):
    pid, slug = setup_investor()
    return api_empty, pid, f"/api/p/{slug}/investments"


def iid(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def raw(n: int, **changes) -> dict:
    data = {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": f"Example fact number {n} " + distinct_words(n),
        "summary": f"Przykladowy fakt {distinct_words(n)} ze zrodla, opisany neutralnie.",
        "sources": [
            {
                "url": f"https://example.com/p5/{n}",
                "publisher": "Example News",
                "published_at": utcnow().date().isoformat(),
            }
        ],
    }
    data.update(changes)
    return data


def add(
    pid: int,
    n: int,
    *,
    instrument: str | None = "XMPL",
    run_id=None,
    created_by: str = "agent",
    **changes,
):
    with get_session() as s:
        data = validate_note(raw(n, **changes), now=utcnow())
        ref = service.resolve_reference(s, pid, instrument) if instrument else None
        added = service.add_note(
            s, s.get(Profile, pid), data, instrument_id=ref, run_id=run_id, created_by=created_by
        )
        return added.note.id


def segment_note(pid: int, n: int, segment: str = "gold", **changes) -> int:
    changes.setdefault("kind", "macro")
    return add(pid, n, instrument=None, segment=segment, **changes)


def call(pid: int, fn, *args, **kwargs):
    with get_session() as s:
        return fn(s, s.get(Profile, pid), *args, **kwargs)


def watch(pid: int, symbol: str) -> int:
    with get_session() as s:
        return watch_service.add(s, s.get(Profile, pid), symbol).item.instrument_id


# --------------------------------------------------------------------------- #
# Instrument segment
# --------------------------------------------------------------------------- #


def test_patch_segment_auto_and_clear(api):
    client, pid, base = api
    abc = iid("ABC")
    row = client.get(f"{base}/instruments").json()
    assert next(r for r in row if r["id"] == abc)["segment"] is None
    before = next(r for r in row if r["id"] == abc)["needs_classification"]
    r = client.patch(f"{base}/instruments/{abc}", json={"segment": "equity_pl"})
    assert r.status_code == 200
    assert (r.json()["segment"], r.json()["segment_source"]) == ("equity_pl", "owner")
    assert r.json()["needs_classification"] == before  # a segment alone is not a review
    bad = client.patch(f"{base}/instruments/{abc}", json={"segment": "Złoto"})
    assert bad.status_code == 422
    cleared = client.patch(f"{base}/instruments/{abc}", json={"segment": None}).json()
    assert (cleared["segment"], cleared["segment_source"]) == (None, None)
    # classification without segment keeps it; with both, both apply
    client.patch(f"{base}/instruments/{abc}", json={"segment": "financials"})
    kept = client.patch(f"{base}/instruments/{abc}", json={"sector": "Banki"}).json()
    assert kept["segment"] == "financials" and kept["sector"] == "Banki"
    gold = watch(pid, "GDXJ.L")
    auto = next(r for r in client.get(f"{base}/instruments").json() if r["id"] == gold)
    assert (auto["segment"], auto["segment_source"]) == ("gold", "auto")
    over = client.patch(f"{base}/instruments/{gold}", json={"segment": "metals"}).json()
    assert (over["segment"], over["segment_source"]) == ("metals", "owner")


# --------------------------------------------------------------------------- #
# GET /research/segments
# --------------------------------------------------------------------------- #


def test_segments_endpoint_shape_windows_and_residual(api):
    client, _pid, base = api
    client.patch(f"{base}/instruments/{iid('ABC')}", json={"segment": "equity_pl"})
    empty = client.get(f"{base}/research/segments").json()
    assert set(empty) == {
        "as_of",
        "start",
        "end",
        "window",
        "base_currency",
        "portfolio_return",
        "explained",
        "residual",
        "new_positions",
        "stale",
        "segments",
        "unassigned",
        "currency",
    }
    # no prices at all: stale everywhere, the series is incomplete -> no residual
    assert empty["portfolio_return"] is None and empty["residual"] is None
    assert empty["window"] == "1w" and empty["base_currency"] == "PLN"
    end = dt.date.fromisoformat(empty["end"])
    assert dt.date.fromisoformat(empty["start"]) == end - dt.timedelta(days=7)
    month = client.get(f"{base}/research/segments?window=4w").json()
    assert dt.date.fromisoformat(month["start"]) == end - dt.timedelta(days=28)
    bad = client.get(f"{base}/research/segments?window=2w")
    assert bad.status_code == 422 and bad.headers["X-Cashu-Error-Code"] == "research_invalid"

    daily.run_daily_check("worker", as_of=dt.date.today(), sources=sources())  # noqa: DTZ011
    flat = client.get(f"{base}/research/segments").json()
    assert flat["portfolio_return"] == 0.0 and flat["residual"] == 0.0 and flat["stale"] == []
    (row,) = flat["segments"]
    assert row["segment"] == "equity_pl" and row["label"] == "Akcje polskie"
    assert row["group"] == "asset" and 0 < row["weight"] < 1 and row["contribution"] == 0.0
    assert row["instruments"][0]["instrument_id"] == iid("ABC")
    assert row["instruments"][0]["label"] == "ABC"
    assert row["note"] is None and row["note_this_week"] is False and row["notes_8w"] == 0
    assert {i["label"] for i in flat["unassigned"]["instruments"]} == {"WRLD", "XMPL"}
    assert flat["unassigned"]["label"] == "Bez tematu"
    assert {c["currency"] for c in flat["currency"]["currencies"]} == {"EUR", "USD"}
    assert flat["currency"]["contribution"] == 0.0 and flat["explained"] == 0.0


def test_segment_with_a_note_and_no_exposure_appears_and_reads(api):
    client, pid, base = api
    note_id = segment_note(pid, 1, "gold", strength=3)
    rows = client.get(f"{base}/research/segments").json()["segments"]
    (gold,) = [r for r in rows if r["segment"] == "gold"]
    assert (gold["weight"], gold["contribution"], gold["return"]) == (0.0, 0.0, None)
    assert gold["note"]["id"] == note_id and gold["note"]["kind"] == "macro"
    assert gold["note"]["strength"] == 3 and gold["note_this_week"] is True
    assert gold["unread"] == 1 and gold["notes_8w"] == 1 and gold["last_note_at"]
    summary = client.get(f"{base}/research/summary").json()
    assert "themes" not in summary and summary["totals"]["notes_unread"] == 1
    marked = client.post(f"{base}/research/read", json={"segment": "gold"}).json()
    assert marked == {"marked": 1}
    assert client.post(f"{base}/research/read", json={"segment": "nope"}).status_code == 422
    rows = client.get(f"{base}/research/segments").json()["segments"]
    assert next(r for r in rows if r["segment"] == "gold")["unread"] == 0
    # the notes list filter and the note dict
    listed = client.get(f"{base}/research?segment=gold").json()
    assert [n["id"] for n in listed] == [note_id]
    assert listed[0]["segment_label"] == "Złoto i górnicy" and listed[0]["instrument_id"] is None
    assert client.get(f"{base}/research?segment=energy").json() == []
    assert client.get(f"{base}/research?segment=Gold").status_code == 422
    # a dismissed note no longer shows as the segment's note (and the row goes without exposure)
    client.patch(f"{base}/research/{note_id}", json={"dismissed": True})
    rows = client.get(f"{base}/research/segments").json()["segments"]
    assert all(r["segment"] != "gold" for r in rows)


# --------------------------------------------------------------------------- #
# Segment notes
# --------------------------------------------------------------------------- #


def test_segment_note_rules(investor):
    pid, _ = investor
    with pytest.raises(service.ResearchError, match=SEGMENT_ONLY):
        add(pid, 1, instrument="XMPL", segment="gold", kind="macro")
    first = segment_note(pid, 2, "gold")
    with pytest.raises(service.ResearchConflict, match="segment gold already has a note this week"):
        segment_note(pid, 3, "gold")
    call(pid, service.dismiss, first)
    with pytest.raises(service.ResearchConflict, match=rf"\(note {first}\)"):
        segment_note(pid, 4, "gold")  # dismissed ones count too
    segment_note(pid, 5, "crypto", kind="trend")  # another segment
    # last ISO week is a different week; the same title within 14 days is still a duplicate
    last_week = (utcnow() - dt.timedelta(days=8)).date().isoformat()
    segment_note(pid, 6, "energy", observed_at=last_week)
    SIX = "Example fact number 6 " + distinct_words(6)
    with pytest.raises(service.ResearchConflict, match="duplicate of note"):
        segment_note(pid, 7, "energy", title=SIX)
    # the same title on another segment is not a duplicate (scope = the segment)
    segment_note(pid, 8, "metals", title=SIX)
    with get_session() as s:
        rows = service.notes(s, pid, segment="energy", include_dismissed=True)
    assert [r.title for r in rows] == [SIX]


def test_segment_note_signal_key_and_payload(investor):
    pid, _ = investor
    note_id = segment_note(pid, 1, "power", strength=3)
    with get_session() as s:
        (sig,) = s.exec(
            select(InvSignal).where(
                InvSignal.profile_id == pid, InvSignal.dedup_key.startswith("research:")
            )
        ).all()
    assert sig.dedup_key.endswith("|s:power") and sig.severity == "info"
    assert sig.instrument_id is None
    assert (
        sig.payload["segment"] == "power"
        and sig.payload["segment_label"] == "Energetyka: atom i OZE"
    )
    assert sig.payload["note_id"] == note_id and sig.payload["theme"] is None


# --------------------------------------------------------------------------- #
# Novelty limits of the weekly run
# --------------------------------------------------------------------------- #


def test_weekly_novelty_limits(investor):
    pid, _ = investor
    for symbol in ("W1.DE", "W2.DE", "W3.DE", "W4.DE"):
        watch(pid, symbol)
    with get_session() as s:
        journal.create_thesis(s, pid, iid("W4"), {"entry_type": "trend", "thesis": "Teza"})
    run = call(pid, service.start_run, RunScope(scheduled=True))
    assert service.is_weekly(run)
    refs = ["ABC", "WRLD", "XMPL", "W1.DE", "W2.DE", "W3.DE"]
    for n, ref in enumerate(refs, start=1):
        add(pid, n, instrument=ref, run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="already covers 6 instruments"):
        add(pid, 10, instrument="W4.DE", run_id=run.id)
    add(pid, 11, instrument="W4.DE", run_id=run.id, strength=3)  # material: passes
    add(pid, 12, instrument="W4.DE", run_id=run.id, thesis_relation="invalidates")
    # two notes per instrument, a third only when material
    add(pid, 13, instrument="ABC", run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="2 notes on this instrument"):
        add(pid, 14, instrument="ABC", run_id=run.id)
    add(pid, 15, instrument="ABC", run_id=run.id, strength=3)
    # six segment notes per week
    for n, segment in enumerate(("gold", "crypto", "bonds", "energy", "metals", "power"), start=20):
        segment_note(pid, n, segment, run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="already has 6 segment notes"):
        segment_note(pid, 30, "healthcare", run_id=run.id)
    call(pid, service.finish_run, run.id)

    on_demand = call(
        pid,
        service.start_run,
        RunScope(held=False, watchlist=False, candidates=False, instruments=("ABC",)),
    )
    assert not service.is_weekly(on_demand)
    for n in range(40, 43):
        add(pid, n, instrument="ABC", run_id=on_demand.id)  # exempt
    segment_note(pid, 43, "healthcare", run_id=on_demand.id)


def test_novelty_counts_per_week_over_weekly_runs_and_notes_without_a_run(investor):
    pid, _ = investor
    for symbol in ("W1.DE", "W2.DE", "W3.DE", "W4.DE"):
        watch(pid, symbol)
    first = call(pid, service.start_run, RunScope(scheduled=True))
    for n, ref in enumerate(["ABC", "WRLD", "XMPL", "W1.DE"], start=1):
        add(pid, n, instrument=ref, run_id=first.id)
    segment_note(pid, 5, "gold", run_id=first.id)
    call(pid, service.finish_run, first.id)
    # a second weekly run in the same ISO week shares the budget
    second = call(pid, service.start_run, RunScope())
    add(pid, 6, instrument="W2.DE", run_id=second.id)
    add(pid, 7, instrument="ABC", run_id=second.id)  # the 2nd ABC note this week
    with pytest.raises(service.ResearchConflict, match="2 notes on this instrument"):
        add(pid, 8, instrument="ABC", run_id=second.id)
    call(pid, service.finish_run, second.id)
    # an agent note without a run counts and is limited
    add(pid, 9, instrument="W3.DE")  # the 6th instrument
    with pytest.raises(service.ResearchConflict, match="already covers 6 instruments"):
        add(pid, 10, instrument="W4.DE")
    add(pid, 11, instrument="W4.DE", strength=3)  # material: passes
    for n, segment in enumerate(("crypto", "bonds", "energy", "metals", "power"), start=12):
        segment_note(pid, n, segment)
    with pytest.raises(service.ResearchConflict, match="already has 6 segment notes"):
        segment_note(pid, 20, "quantum")
    # the owner's own notes are never limited
    add(pid, 21, instrument="ABC", created_by="user")


def test_scope_with_only_instruments_or_segments_is_on_demand(investor):
    pid, _ = investor
    from cashu.modules.investments.research.validation import validate_scope

    for raw_scope in ({"instruments": ["ABC"]}, {"segments": ["gold"]}):
        scope = validate_scope(raw_scope)
        assert (scope.held, scope.watchlist, scope.candidates) == (False, False, False)
    assert validate_scope({"instruments": ["ABC"], "held": True}).held is True
    assert validate_scope({}).held is True and validate_scope({"themes": ["Banki"]}).held is True
    run = call(pid, service.start_run, validate_scope({"instruments": ["ABC"]}))
    assert not service.is_weekly(run)
    for n in range(1, 4):
        add(pid, n, instrument="ABC", run_id=run.id)  # exempt: three notes on one instrument


def test_one_segment_note_per_week_of_storing_too(investor):
    pid, _ = investor
    segment_note(pid, 1, "gold")
    back = (utcnow() - dt.timedelta(days=15)).date().isoformat()
    with pytest.raises(service.ResearchConflict, match="segment gold already has a note this week"):
        segment_note(pid, 2, "gold", observed_at=back)  # back-dated, stored this week
    segment_note(pid, 3, "crypto", observed_at=back)  # another segment is fine


# --------------------------------------------------------------------------- #
# Review digest
# --------------------------------------------------------------------------- #


def test_review_digest_carries_the_week_segments(investor):
    pid, _ = investor
    keys = ("gold", "crypto", "bonds", "energy", "metals", "power", "quantum")
    run = call(pid, service.start_run, RunScope(held=False, segments=keys))  # on demand
    for n, segment in enumerate(keys, start=1):
        segment_note(pid, n, segment, run_id=run.id)
    with get_session() as s:
        block = views.research_digest(s, pid, utcnow() - dt.timedelta(days=7))
    assert "themes_changed" not in block
    assert len(block["segments"]) == 6  # top rows only
    assert [r["segment"] for r in block["segments"]][:2] == ["bonds", "gold"]  # catalog order
    assert block["market"]["window"] == "1w" and "segments" not in block["market"]
    assert {"portfolio_return", "explained", "residual", "currency", "unassigned"} <= set(
        block["market"]
    )


# --------------------------------------------------------------------------- #
# Attribution through the service (valuation at the window start -> rows)
# --------------------------------------------------------------------------- #

TODAY = dt.date.today()  # noqa: DTZ011 - the performance computation ends today
START = TODAY - dt.timedelta(days=7)


def _d(days: int) -> str:
    return (TODAY - dt.timedelta(days=days)).isoformat()


def _moving_portfolio(*, eur_from: dt.date | None = None, eur_gap: int = 0) -> tuple[int, str]:
    """A PLN deposit, ABC (PLN) +10 % and WRLD (EUR) -10 % within the window with EUR +10 %, a
    cost-valued treasury bond, cash, and XMPL (USD, flat) bought in the middle of the window.
    ``eur_from``: EUR rates only from that day on; ``eur_gap``: no EUR rate in the ``eur_gap`` days
    up to the window start (the start rate is then too old for the valuation)."""
    from decimal import Decimal

    from invp_support import HEADER

    from cashu.modules.investments.domain import Currency, FxRate, PriceBar
    from cashu.modules.investments.store import instruments as instrument_store
    from cashu.modules.investments.store import market

    rows = [
        f"1,txn,{_d(30)},09:00,deposit,M-1,,,,,,,PLN,,,,20000.00,,,,",
        (
            f"1,txn,{_d(20)},10:00,buy,M-2,ABC,PLABC0000016,ABC Example SA,XWAR,100,50.00,PLN,"
            "5000.00,,,-5000.00,,,,"
        ),
        (
            f"1,txn,{_d(20)},10:00,buy,M-3,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,100.00,"
            "EUR,1000.00,,,-4000.00,PLN,4.0,,"
        ),
        (
            f"1,txn,{_d(20)},10:00,buy,M-4,EDOX,PL0000000002,Example Treasury Bond,XWAR,10,100.00,"
            "PLN,1000.00,,,-1000.00,,,,"
        ),
        (
            f"1,txn,{_d(3)},10:00,buy,M-5,XMPL,US0000000001,Example Corp,XNAS,10,100.00,USD,1000.00,,,"
            "-4000.00,PLN,4.0,,"
        ),
    ]
    pid, slug = make_profile("Ruchomy")
    aid = add_account(pid)
    import_file(pid, aid, ("\n".join([HEADER, *rows]) + "\n").encode("utf-8"))
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    days = [TODAY - dt.timedelta(days=i) for i in range(40, -1, -1)]
    with get_session() as s:
        ids = {sym: iid(sym) for sym in ("ABC", "WRLD", "EDOX", "XMPL")}
        instrument_store.classify(s, ids["EDOX"], profile_id=pid, asset_class="treasury_bond")
        instrument_store.set_segment(s, ids["ABC"], "equity_pl", profile_id=pid, by="owner")
        instrument_store.set_segment(s, ids["WRLD"], "equity_global", profile_id=pid, by="owner")
        closes = {
            "ABC": lambda d: 50 if d <= START else 55,
            "WRLD": lambda d: 100 if d <= START else 90,
            "XMPL": lambda d: 100,
        }
        market.upsert_bars(
            s,
            [
                PriceBar(str(ids[sym]), d, Decimal(close(d)), "test")
                for sym, close in closes.items()
                for d in days
            ],
            now=utcnow(),
        )
        eur = [
            FxRate(Currency("EUR"), d, Decimal("4.0" if d <= START else "4.4"), "test")
            for d in days
            if (eur_from is None or d >= eur_from)
            and not (START - dt.timedelta(eur_gap) < d <= START)
        ]
        usd = [FxRate(Currency("USD"), d, Decimal("4.0"), "test") for d in days]
        market.upsert_rates(s, [*eur, *usd], now=utcnow())
    return pid, slug


def _view(pid: int, window: str = "1w") -> dict:
    from cashu.modules.investments.research import segment_service

    with get_session() as s:
        return segment_service.segments_view(s, s.get(Profile, pid), window=window)


def test_attribution_with_moving_prices_fx_cost_holding_cash_and_a_mid_window_buy(db_engine):
    pid, _ = _moving_portfolio()
    view = _view(pid)
    rows = {r["segment"]: r for r in view["segments"]}
    assert [r["segment"] for r in view["segments"]] == ["equity_pl", "equity_global", "bonds"]
    pl, world, bonds = rows["equity_pl"], rows["equity_global"], rows["bonds"]
    # T0 = 10000 cash + 5000 ABC + 4000 WRLD (10 x 100 EUR x 4.0) + 1000 bond at cost
    assert (pl["weight"], pl["contribution"], pl["return"]) == (0.25, 0.025, 0.1)
    assert (world["weight"], world["contribution"], world["return"]) == (0.2, -0.02, -0.1)
    assert (bonds["weight"], bonds["contribution"], bonds["return"]) == (0.05, 0.0, None)
    assert bonds["instruments"][0]["label"] == "EDOX"
    assert view["unassigned"] is None and view["new_positions"] == 1  # XMPL
    (eur,) = view["currency"]["currencies"]
    assert (eur["currency"], eur["weight"], eur["return"]) == ("EUR", 0.2, 0.1)
    assert eur["contribution"] == 0.018 and view["currency"]["contribution"] == 0.018
    assert view["explained"] == 0.023 and view["portfolio_return"] == 0.023
    assert view["residual"] == 0.0 and view["stale"] == []


def test_a_start_rate_too_old_still_values_the_holding_and_flags_it(db_engine):
    pid, _ = _moving_portfolio(eur_gap=15)  # the newest EUR rate at the start is 16 days old
    view = _view(pid)
    rows = {r["segment"]: r for r in view["segments"]}
    assert rows["equity_global"]["weight"] == 0.2 and rows["equity_global"]["contribution"] == -0.02
    assert rows["equity_pl"]["weight"] == 0.25  # T0 still has WRLD
    assert view["new_positions"] == 1  # WRLD was held: only XMPL is new
    assert iid("WRLD") in view["stale"]


def test_a_holding_without_any_start_rate_is_left_out_and_flagged(db_engine):
    pid, _ = _moving_portfolio(eur_from=START + dt.timedelta(days=1))
    view = _view(pid)
    rows = {r["segment"]: r for r in view["segments"]}
    world = rows["equity_global"]  # still held: a topic row without exposure (P7), its trend only
    assert (world["weight"], world["contribution"], world["return"]) == (0.0, 0.0, None)
    assert (world["trend_1w"], world["members"]) == (-0.1, 1)
    assert view["segments"][-1]["segment"] == "equity_global"  # after the rows with exposure
    assert rows["equity_pl"]["weight"] == round(5000 / 16000, 6)  # T0 without WRLD
    assert view["new_positions"] == 1 and iid("WRLD") in view["stale"]


def test_rounding_never_gives_negative_zero():
    from cashu.modules.investments.research.segment_service import _r

    assert str(_r(-1e-9)) == "0.0" and _r(None) is None and _r(-0.0123456789) == -0.012346
