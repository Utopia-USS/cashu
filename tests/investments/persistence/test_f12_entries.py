"""F12 against a real DB: one entry per (profile, instrument) (soft remove, restore of the same row by
instrument id, free text and search pick; research, theses, alerts, note and tags survive; removed rows
are neither listed nor fetched; MAX_ITEMS counts active rows), research accept / undo on the soft model,
adding a search pick (verified, unverified, ISIN collision), the free-text search fallback, and the search
service (local matching and states, remote merge, OpenFIGI only for ISINs, unavailable remote, cache).
Synthetic portfolio data; remote answers are recorded public market data (no live HTTP)."""

from __future__ import annotations

import datetime as dt

import pytest
from f12_support import Recorded, install
from invp_support import (
    AS_OF,
    FakePrices,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
)
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.domain import AssetClass, Currency, Instrument
from cashu.modules.investments.models import (
    InvInstrument,
    InvInstrumentAlias,
    InvPriceBar,
    InvResearchNote,
    InvWatchlistItem,
)
from cashu.modules.investments.research import service as research
from cashu.modules.investments.research.validation import validate_note
from cashu.modules.investments.service import alerts as alert_service
from cashu.modules.investments.service import daily, entries, instrument_search
from cashu.modules.investments.service import watchlist as watch
from cashu.modules.investments.store import alerts as alert_store
from cashu.modules.investments.store import instruments, journal


@pytest.fixture
def investor(db_engine):
    pid, _slug = make_profile("Obserwator")
    import_file(pid, add_account(pid), canonical_csv())
    return pid


def run(pid: int, fn, *args, **kwargs):
    with get_session() as s:
        return fn(s, s.get(Profile, pid), *args, **kwargs)


def iid(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def research_note(pid: int, instrument_id: int, n: int = 1) -> int:
    raw = {
        "kind": "news",
        "polarity": "neutral",
        "strength": 1,
        "title": f"Example fact number {n}",
        "summary": "Przykladowy fakt ze zrodla, opisany neutralnie.",
        "sources": [
            {
                "url": f"https://example.com/news/{n}",
                "publisher": "Example News",
                "published_at": utcnow().date().isoformat(),
            }
        ],
    }
    with get_session() as s:
        data = validate_note(raw, now=utcnow())
        return research.add_note(s, s.get(Profile, pid), data, instrument_id=instrument_id).note.id


# --------------------------------------------------------------------------- #
# One entry per (profile, instrument)
# --------------------------------------------------------------------------- #


def test_remove_keeps_everything_and_every_add_path_restores_the_same_row(investor, monkeypatch):
    pid = investor
    added = run(pid, watch.add, "NEWCO.WA", note="moja notatka", tags=["polska"])
    item_id, newco = added.item.id, added.item.instrument_id
    assert added.restored is False
    with get_session() as s:
        journal.create_thesis(s, pid, newco, {"entry_type": "trend", "thesis": "Moja teza"})
        alert_service.create(
            s,
            s.get(Profile, pid),
            alert_service.AlertInput(
                kind="price_above", title="NEWCO 10", params={"level": 10}, instrument_id=newco
            ),
        )
    note_id = research_note(pid, newco)

    removed = run(pid, watch.remove, item_id)
    assert removed.removed_at is not None
    with get_session() as s:
        row = s.get(InvWatchlistItem, item_id)  # never deleted
        assert (row.note, row.tags) == ("moja notatka", ["polska"])
        assert alert_store.watchlist(s, pid) == []
        assert alert_store.watched_instrument_ids(s, pid) == set()
        assert alert_store.watched_item_for(s, pid, newco) is None
        assert alert_store.watch_row_for(s, pid, newco).id == item_id
        assert newco in instruments.profile_instrument_ids(s, pid)
        assert entries.entry_states(s, s.get(Profile, pid), [newco, iid("XMPL")]) == {
            newco: "saved",
            iid("XMPL"): "held",
        }
        assert journal.theses(s, pid, newco)[0].thesis == "Moja teza"
        assert [a.title for a in alert_store.alerts(s, pid)] == ["NEWCO 10"]
        assert s.get(InvResearchNote, note_id) is not None
    with pytest.raises(watch.WatchlistNotFound):
        run(pid, watch.remove, item_id)
    with pytest.raises(watch.WatchlistNotFound):
        run(pid, watch.update, item_id, note="x")

    # by instrument id: the same row, note and tags kept, moved to the end, source = this adder
    before = removed.added_at
    again = run(pid, watch.add, instrument_id=newco, source=watch.AlertSource.AGENT)
    assert (again.item.id, again.restored, again.created_instrument) == (item_id, True, False)
    assert (again.item.note, again.item.tags, again.item.source) == (
        "moja notatka",
        ["polska"],
        "agent",
    )
    assert again.item.added_at >= before and again.item.removed_at is None
    with pytest.raises(watch.WatchlistConflict):
        run(pid, watch.add, instrument_id=newco)

    # by free text: tags passed -> replaced, note kept
    run(pid, watch.remove, item_id)
    text = run(pid, watch.add, "newco.wa", tags=["nowe"])
    assert (text.item.id, text.restored, text.item.note, text.item.tags) == (
        item_id,
        True,
        "moja notatka",
        ["nowe"],
    )

    # by search pick: the stored instrument by its (guessed) Yahoo alias, no network at all
    run(pid, watch.remove, item_id)
    rec = install(monkeypatch)
    picked = run(pid, watch.add, pick=watch.SearchPick("NEWCO.WA"), note="nowa notatka")
    assert (picked.item.id, picked.restored, picked.item.note) == (item_id, True, "nowa notatka")
    assert rec.requests == []
    with get_session() as s:
        rows = s.exec(select(InvWatchlistItem).where(InvWatchlistItem.profile_id == pid)).all()
        assert len(rows) == 1


def test_an_instrument_referenced_only_by_research_stays_in_the_profile(investor):
    pid = investor
    with get_session() as s:
        row = instruments.insert(
            s,
            Instrument(
                id="x",
                name="Research Only SA",
                currency=Currency.PLN,
                asset_class=AssetClass.EQUITY,
            ),
        )
        only = row.id
    note_id = research_note(pid, only, 7)
    with get_session() as s:
        assert only in instruments.profile_instrument_ids(s, pid)
        s.get(InvResearchNote, note_id).dismissed_at = utcnow()  # dismissed research still counts
    with get_session() as s:
        assert only in instruments.profile_instrument_ids(s, pid)
        assert entries.entry_states(s, s.get(Profile, pid), [only]) == {only: "saved"}


def test_max_items_counts_active_rows_only(investor, monkeypatch):
    pid = investor
    monkeypatch.setattr(watch, "MAX_ITEMS", 2)
    first = run(pid, watch.add, "AAA.WA").item.id
    run(pid, watch.add, "BBB.WA")
    with pytest.raises(watch.WatchlistError, match="at most 2"):
        run(pid, watch.add, "CCC.WA")
    run(pid, watch.remove, first)
    run(pid, watch.add, "CCC.WA")  # the removed row does not count
    with pytest.raises(watch.WatchlistError, match="at most 2"):
        run(pid, watch.add, instrument_id=iid("AAA"))  # restoring counts like adding


def test_removed_rows_are_not_fetched_by_the_daily_check(investor):
    pid = investor
    item = run(pid, watch.add, "NEWCO.WA").item
    fake = FakePrices()
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))
    assert "NEWCO.WA" in {symbol for symbol, _start, _end in fake.calls}
    run(pid, watch.remove, item.id)
    fake = FakePrices()
    daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))
    assert "NEWCO.WA" not in {symbol for symbol, _start, _end in fake.calls}


# --------------------------------------------------------------------------- #
# Research accept / undo
# --------------------------------------------------------------------------- #

CANDIDATE = {
    "kind": "candidate",
    "polarity": "positive",
    "strength": 2,
    "title": "Newco: kandydat",
    "summary": "Przykladowy kandydat ze zrodla, opisany neutralnie.",
    "candidate": {"symbol_or_isin": "NEWCO.WA", "name": "Newco SA"},
    "details": {
        "entry_type": "sentiment_correction",
        "criteria": [{"text": "C/Z 9,8", "met": True, "threshold": "max 15"}],
    },
    "sources": [
        {
            "url": "https://example.com/c/1",
            "publisher": "Example",
            "published_at": utcnow().date().isoformat(),
        }
    ],
}


def candidate(pid: int) -> int:
    with get_session() as s:
        data = validate_note(dict(CANDIDATE), now=utcnow())
        return research.add_note(s, s.get(Profile, pid), data, instrument_id=None).note.id


def test_accept_restores_a_removed_row_and_undo_removes_it_again(investor):
    pid = investor
    own = run(pid, watch.add, "NEWCO.WA", note="moja obserwacja", tags=["x"]).item
    run(pid, watch.remove, own.id)
    note_id = candidate(pid)
    accepted = run(pid, research.accept_candidate, note_id)
    assert accepted.watchlist_item_id == own.id
    with get_session() as s:
        row = s.get(InvWatchlistItem, own.id)
        assert row.removed_at is None and row.note == "moja obserwacja"  # the owner's note stays
        details = s.get(InvResearchNote, note_id).details
        assert details["restored_watchlist_item"] is True
        assert details["created_watchlist_item"] is False
    run(pid, research.undo_accept, note_id)
    with get_session() as s:
        row = s.get(InvWatchlistItem, own.id)
        assert row.removed_at is not None  # back to removed, never deleted
        assert (row.note, row.tags) == ("moja obserwacja", ["x"])
        assert "restored_watchlist_item" not in (s.get(InvResearchNote, note_id).details or {})


def test_accept_of_a_removed_row_without_a_note_and_its_undo(investor):
    pid = investor
    own = run(pid, watch.add, "NEWCO.WA").item
    run(pid, watch.remove, own.id)
    note_id = candidate(pid)
    run(pid, research.accept_candidate, note_id)
    with get_session() as s:
        assert s.get(InvWatchlistItem, own.id).note == "kandydat: Newco: kandydat"
    run(pid, research.undo_accept, note_id)
    with get_session() as s:
        row = s.get(InvWatchlistItem, own.id)
        assert row.removed_at is not None and row.note is None


# --------------------------------------------------------------------------- #
# Adding a search pick
# --------------------------------------------------------------------------- #


def aliases(instrument_id: int) -> dict[str, tuple[str, bool]]:
    with get_session() as s:
        rows = s.exec(
            select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id == instrument_id)
        ).all()
        return {a.namespace: (a.value, a.guessed) for a in rows}


def bar_count(instrument_id: int) -> int:
    with get_session() as s:
        return len(
            s.exec(select(InvPriceBar.id).where(InvPriceBar.instrument_id == instrument_id)).all()
        )


def test_a_verified_pick_takes_the_chart_currency_a_confirmed_alias_and_the_bars(
    investor, monkeypatch
):
    pid = investor
    rec = install(monkeypatch)
    pick = watch.SearchPick(
        "VWRA.L", "VWRA", "Vanguard FTSE All-World UCITS ETF USD Acc", "etf", "XLON", "IE00BK5BQT80"
    )
    added = run(pid, watch.add, pick=pick)
    assert (added.created_instrument, added.restored, added.warnings) == (True, False, [])
    vwra = added.item.instrument_id
    with get_session() as s:
        row = s.get(InvInstrument, vwra)
        assert (row.symbol, row.mic, row.currency, row.asset_class) == (
            "VWRA",
            "XLON",
            "USD",
            "etf",
        )
        assert row.isin == "IE00BK5BQT80" and row.needs_classification is False
    assert aliases(vwra) == {
        "yahoo": ("VWRA.L", False),
        "stooq": ("vwra.uk", True),
        "isin": ("IE00BK5BQT80", False),
    }
    assert bar_count(vwra) > 200  # price and sparkline at once
    with get_session() as s:
        bar = s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == vwra)).first()
        assert (bar.source, bar.currency) == ("yahoo", "USD")
    assert len(rec.paths("/v8/finance/chart/VWRA.L")) == 1

    # another listing of the same ISIN: created without the ISIN, never an error
    vwce = run(pid, watch.add, pick=watch.SearchPick("VWCE.DE", isin="IE00BK5BQT80"))
    with get_session() as s:
        row = s.get(InvInstrument, vwce.item.instrument_id)
        assert (row.symbol, row.mic, row.currency, row.isin) == ("VWCE", "XETR", "EUR", None)
        assert row.name == "Vanguard FTSE All-World UCITS ETF USD Accumulation"  # chart longName
        assert row.asset_class == "etf"  # from the chart instrumentType
    assert "isin" not in aliases(vwce.item.instrument_id)

    # a stored listing (any case) is used as is: no second chart request
    run(pid, watch.remove, vwce.item.id)
    again = run(pid, watch.add, pick=watch.SearchPick("vwce.de"))
    assert (again.item.id, again.restored) == (vwce.item.id, True)
    assert len(rec.paths("/v8/finance/chart/VWCE.DE")) == 1


def test_an_unverified_pick_keeps_a_guessed_alias_and_warns(investor, monkeypatch):
    pid = investor
    install(monkeypatch, Recorded(chart_down=True))
    added = run(pid, watch.add, pick=watch.SearchPick("PKN.WA", "PKN", "Orlen S.A.", "equity"))
    assert added.created_instrument
    assert [w.code for w in added.warnings] == ["watchlist.unverified_price_symbol"]
    assert added.warnings[0].params == {"symbol": "PKN.WA"}
    pkn = added.item.instrument_id
    with get_session() as s:
        row = s.get(InvInstrument, pkn)
        assert (row.symbol, row.mic, row.currency, row.name) == ("PKN", "XWAR", "PLN", "Orlen S.A.")
    assert aliases(pkn)["yahoo"] == ("PKN.WA", True) and bar_count(pkn) == 0
    btc = run(pid, watch.add, pick=watch.SearchPick("BTC-USD", "BTC", "Bitcoin USD", "crypto"))
    with get_session() as s:
        row = s.get(InvInstrument, btc.item.instrument_id)
        assert (row.symbol, row.mic, row.currency, row.asset_class) == (
            "BTC",
            None,
            "USD",
            "crypto",
        )
        assert row.needs_classification is False
    # an unknown suffix without a chart: no currency can be told, nothing is created
    with get_session() as s:
        before = len(s.exec(select(InvInstrument.id)).all())
    with pytest.raises(watch.WatchlistError, match="Cannot tell the currency of VWCE.MU"):
        run(pid, watch.add, pick=watch.SearchPick("VWCE.MU"))
    with get_session() as s:
        assert len(s.exec(select(InvInstrument.id)).all()) == before
    # a 404 chart (unknown symbol) is unverified too
    install(monkeypatch)
    nope = run(pid, watch.add, pick=watch.SearchPick("NOPE.DE", name="Nope AG"))
    assert [w.code for w in nope.warnings] == ["watchlist.unverified_price_symbol"]


def test_pick_input_is_validated(investor, monkeypatch):
    pid = investor
    install(monkeypatch)
    for pick, message in (
        (watch.SearchPick("a b"), "yahoo_symbol"),
        (watch.SearchPick("VWCE.DE", asset_class="stock"), "asset class"),
        (watch.SearchPick("VWCE.DE", mic="XMARS"), "Unknown market"),
        (watch.SearchPick("VWCE.DE", isin="IE00"), "ISIN"),
    ):
        with pytest.raises(watch.WatchlistError, match=message):
            run(pid, watch.add, pick=pick)


# --------------------------------------------------------------------------- #
# Free text
# --------------------------------------------------------------------------- #


def test_free_text_asks_the_search_only_where_it_fails_today(investor, monkeypatch):
    pid = investor
    rec = install(monkeypatch)
    nvda = run(pid, watch.add, "NVDA")
    with get_session() as s:
        row = s.get(InvInstrument, nvda.item.instrument_id)
        assert (row.symbol, row.mic, row.currency) == ("NVDA", "XNAS", "USD")
    assert aliases(nvda.item.instrument_id)["yahoo"] == ("NVDA", False)
    with pytest.raises(watch.WatchlistError) as e:
        run(pid, watch.add, "VWCE")
    assert str(e.value) == (
        'Several listings match "VWCE": VWCE.DE (XETRA), VWCE.MI (Milan), VWCE.AS (Amsterdam) '
        "- pass one of them"
    )
    # an unknown ISIN without currency: one listing on a known market
    vwra = run(pid, watch.add, "IE00BK5BQT80")
    with get_session() as s:
        row = s.get(InvInstrument, vwra.item.instrument_id)
        assert (row.symbol, row.currency, row.isin) == ("VWRA", "USD", "IE00BK5BQT80")
    # deterministic paths never search
    searched = len(rec.paths("/v1/finance/search"))
    run(pid, watch.add, "PKN.WA")
    run(pid, watch.add, "MSFT", exchange="nasdaq")
    assert len(rec.paths("/v1/finance/search")) == searched


def test_free_text_without_search_keeps_the_old_errors(investor, monkeypatch):
    pid = investor
    install(monkeypatch, Recorded(search_down=True, figi_down=True))
    with pytest.raises(watch.WatchlistError, match="Cannot tell the market"):
        run(pid, watch.add, "NVDA")
    with pytest.raises(watch.WatchlistError, match="give its currency"):
        run(pid, watch.add, "IE00BK5BQT80")
    # Yahoo down, OpenFIGI up: an ISIN with several listings names them
    install(monkeypatch, Recorded(search_down=True))
    with pytest.raises(watch.WatchlistError, match=r"VWRA.L \(LSE\), VWRP.L \(LSE\), VWCE.DE"):
        run(pid, watch.add, "IE00BK5BQT80")
    install(monkeypatch)
    with pytest.raises(watch.WatchlistError, match="Cannot tell the market"):
        run(pid, watch.add, "ZZZZ")  # nothing found


# --------------------------------------------------------------------------- #
# Search service
# --------------------------------------------------------------------------- #


def search(pid: int, q: str, **kwargs) -> instrument_search.SearchResult:
    with get_session() as s:
        return instrument_search.search(s, s.get(Profile, pid), q, **kwargs)


def test_local_matching_order_and_states(investor):
    pid = investor
    watched = run(pid, watch.add, "EXAMPLE.WA", name="Przykład Wodociągi Łódź")
    saved = run(pid, watch.add, "EXB.WA", name="Example Bravo")
    run(pid, watch.remove, saved.item.id)
    result = search(pid, "ex", remote=False)
    assert result.remote_status == "skipped" and result.remote == []
    # ticker prefixes first, then names (alphabetical within each)
    assert [(h.symbol, h.state) for h in result.local] == [
        ("EXAMPLE", "watched"),
        ("EXB", "saved"),
        ("ABC", "held"),  # name "ABC Example SA"
        ("XMPL", "held"),  # name "Example Corp"
    ]
    hit = result.local[0]
    assert hit.key == f"i:{watched.item.instrument_id}" and hit.source == "local"
    assert (hit.exchange, hit.mic, hit.currency, hit.yahoo_symbol) == (
        "GPW",
        "XWAR",
        "PLN",
        "EXAMPLE.WA",
    )
    # exact ISIN, alias prefix, name without diacritics
    assert [h.symbol for h in search(pid, "us0000000001", remote=False).local] == ["XMPL"]
    assert [h.symbol for h in search(pid, "exb.w", remote=False).local] == ["EXB"]
    assert [h.symbol for h in search(pid, "wodociagi lodz", remote=False).local] == ["EXAMPLE"]
    # exact ticker beats a prefix match
    assert [h.symbol for h in search(pid, "exb", remote=False).local] == ["EXB"]
    assert search(pid, "xmpl", remote=False).local[0].state == "held"


def test_query_rules(investor):
    pid = investor
    for bad in ("", "   ", "x" * 61):
        with pytest.raises(instrument_search.SearchError):
            search(pid, bad)
    assert search(pid, "a").remote_status == "skipped"  # one character: local only
    assert search(pid, "ab").remote_status == "unavailable"  # tests are offline by default


def test_remote_hits_merge_with_stored_instruments(investor, monkeypatch):
    pid = investor
    other, _ = make_profile("Druga")
    rec = install(monkeypatch)
    vwce = run(pid, watch.add, pick=watch.SearchPick("VWCE.DE")).item.instrument_id
    mine = search(pid, "VWCE")
    assert mine.remote_status == "ok"
    assert [(h.symbol, h.state, h.source) for h in mine.local] == [("VWCE", "watched", "local")]
    assert "VWCE.DE" not in {h.yahoo_symbol for h in mine.remote}  # not repeated
    first = mine.remote[0]
    assert (first.key, first.instrument_id, first.state, first.source) == (
        "y:VWCE.MI",
        None,
        "new",
        "yahoo",
    )
    assert (first.exchange, first.mic, first.currency) == ("Milan", "XMIL", "EUR")
    theirs = search(other, "vwce")
    stored = next(h for h in theirs.remote if h.yahoo_symbol == "VWCE.DE")
    # another profile's instrument: never exposed (no id), a plain new listing
    assert (stored.key, stored.instrument_id, stored.state) == ("y:VWCE.DE", None, "new")
    assert theirs.local == [] and vwce not in {h.instrument_id for h in theirs.remote}
    # the profile's own instrument found only remotely (the text matches no local field)
    run(pid, watch.add, pick=watch.SearchPick("PKN.WA", "PKN", "Polski Koncern", "equity"))
    orlen = search(pid, "orlen")
    assert [(h.symbol, h.state) for h in orlen.local] == [("PKN", "watched")]
    assert "PKN.WA" not in {h.yahoo_symbol for h in orlen.remote}
    assert len(orlen.remote) <= 8
    assert rec.paths("api.openfigi.com") == []  # never asked for a non-ISIN query


def test_isin_queries_merge_openfigi_listings_after_yahoo(investor, monkeypatch):
    pid = investor
    rec = install(monkeypatch)
    pkn = search(pid, "PLPKN0000018")  # Yahoo: no quotes
    assert pkn.remote_status == "ok"
    assert [(h.yahoo_symbol, h.source, h.isin) for h in pkn.remote][:1] == [
        ("PKN.WA", "openfigi", "PLPKN0000018")
    ]
    assert pkn.remote[0].exchange == "GPW"
    vwra = search(pid, "IE00BK5BQT80")
    symbols = [h.yahoo_symbol for h in vwra.remote]
    # Yahoo's hits first, then OpenFIGI's other listings, deduplicated (VWRA.L once)
    assert symbols[:2] == ["VWRA.L", "IE00BK5BQT80.SG"]
    assert [h.source for h in vwra.remote[:3]] == ["yahoo", "yahoo", "openfigi"]
    assert symbols.count("VWRA.L") == 1 and "VWCE.DE" in symbols and "VWRP.L" in symbols
    assert len(symbols) <= 8
    assert len(rec.paths("api.openfigi.com")) == 2
    search(pid, "orlen")
    assert len(rec.paths("api.openfigi.com")) == 2  # never for a non-ISIN query
    # Yahoo down, OpenFIGI up: still ok
    install(monkeypatch, Recorded(search_down=True))
    assert search(pid, "US67066G1040").remote[0].yahoo_symbol == "NVDA"


def test_a_partial_answer_is_not_cached_and_the_key_is_the_text_sent(investor, monkeypatch):
    pid = investor
    rec = install(monkeypatch, Recorded(figi_down=True))
    for _ in range(2):
        result = search(pid, "IE00BK5BQT80")
        assert result.remote_status == "ok"  # Yahoo worked
        assert [h.yahoo_symbol for h in result.remote] == ["VWRA.L", "IE00BK5BQT80.SG"]
    assert len(rec.paths("/v1/finance/search")) == 2  # OpenFIGI failed: not cached, asked again
    search(pid, "zlota")
    search(pid, "złota")  # a different query for Yahoo: its own cache entry
    search(pid, " ZŁOTA ")
    assert len(rec.paths("/v1/finance/search")) == 4


def test_the_detached_search_holds_no_session_during_remote_io(investor, monkeypatch):
    from contextlib import contextmanager

    pid = investor
    open_sessions = []

    @contextmanager
    def factory():
        with get_session() as s:
            open_sessions.append(1)
            try:
                yield s
            finally:
                open_sessions.pop()

    class Probe:
        def search(self, query):
            assert open_sessions == [], "a session is open during the remote search"
            return []

    with get_session() as s:
        profile = s.get(Profile, pid)
    result = instrument_search.search_detached(
        profile,
        "examp",
        sources=instrument_search.SearchSources(Probe()),
        session_factory=factory,
    )
    assert result.remote_status == "ok"
    assert {h.symbol for h in result.local} == {"ABC", "XMPL"}


def test_remote_failure_keeps_local_results_and_the_cache_spares_yahoo(investor, monkeypatch):
    pid = investor
    run(pid, watch.add, "EXAMPLE.WA", name="Orlen Example")
    down = install(monkeypatch, Recorded(search_down=True, figi_down=True))
    result = search(pid, "orlen")
    assert result.remote_status == "unavailable" and result.remote == []
    assert [h.symbol for h in result.local] == ["EXAMPLE"]
    assert search(pid, "PLPKN0000018").remote_status == "unavailable"
    assert down.requests  # it did try
    rec = install(monkeypatch)
    for q in ("orlen", "Orlen", " ORLEN "):
        assert search(pid, q).remote_status == "ok"
    assert len(rec.paths("/v1/finance/search")) == 1  # one request for the same normalized query
    monkeypatch.setattr(instrument_search, "_clock", lambda: 10_000_000.0)  # past the TTL
    search(pid, "orlen")
    assert len(rec.paths("/v1/finance/search")) == 2


def test_states_follow_holdings(investor):
    pid = investor
    xmpl = iid("XMPL")
    run(pid, watch.add, instrument_id=xmpl)  # watching a held instrument: still held
    with get_session() as s:
        profile = s.get(Profile, pid)
        assert entries.entry_states(s, profile, [xmpl]) == {xmpl: "held"}
        assert entries.entry_states(s, profile, [999_999]) == {999_999: "new"}
        assert entries.entry_states(s, profile, []) == {}


def test_today_is_used_for_the_pick_window(investor, monkeypatch):
    from cashu.modules.investments.service import portfolio

    pid = investor
    rec = install(monkeypatch)
    monkeypatch.setattr(portfolio, "today", lambda: dt.date(2026, 6, 1))
    vwce = run(pid, watch.add, pick=watch.SearchPick("VWCE.DE")).item.instrument_id
    with get_session() as s:
        dates = s.exec(select(InvPriceBar.date).where(InvPriceBar.instrument_id == vwce)).all()
    assert max(dates) <= dt.date(2026, 6, 1)
    assert "period2" in str(rec.paths("/v8/finance/chart/")[0])


def test_a_typed_symbol_with_its_market_is_verified_like_a_pick(investor, monkeypatch):
    pid = investor
    rec = install(monkeypatch)
    added = run(pid, watch.add, "VWRA.L")
    assert (added.created_instrument, added.warnings) == (True, [])
    vwra = added.item.instrument_id
    with get_session() as s:
        row = s.get(InvInstrument, vwra)
        assert (row.symbol, row.mic, row.currency, row.asset_class) == (
            "VWRA",
            "XLON",
            "USD",
            "etf",
        )
        assert row.needs_classification is False
    assert aliases(vwra)["yahoo"] == ("VWRA.L", False) and bar_count(vwra) > 200
    assert len(rec.paths("/v1/finance/search")) == 0  # no search needed
    # verification fails: today's guessed path (market currency) plus the unverified warning
    install(monkeypatch, Recorded(chart_down=True))
    guessed = run(pid, watch.add, "GDXJ.L")
    assert [w.code for w in guessed.warnings] == [
        "watchlist.guessed_price_symbol",
        "watchlist.unverified_price_symbol",
    ]
    with get_session() as s:
        assert s.get(InvInstrument, guessed.item.instrument_id).currency == "GBP"
    assert aliases(guessed.item.instrument_id)["yahoo"] == ("GDXJ.L", True)
    # an explicit currency keeps the deterministic path (no chart request)
    install(monkeypatch, rec)
    before = len(rec.paths("/v8/finance/chart/"))
    run(pid, watch.add, "VWCE.MI", currency="EUR")
    assert len(rec.paths("/v8/finance/chart/")) == before


def test_undo_keeps_a_note_the_owner_edited_after_the_accept(investor):
    pid = investor
    own = run(pid, watch.add, "NEWCO.WA").item
    run(pid, watch.remove, own.id)
    note_id = candidate(pid)
    run(pid, research.accept_candidate, note_id)
    run(pid, watch.update, own.id, note="moja nowa notatka")
    run(pid, research.undo_accept, note_id)
    with get_session() as s:
        row = s.get(InvWatchlistItem, own.id)
        assert row.removed_at is not None and row.note == "moja nowa notatka"


def test_pick_symbols_with_class_shares_and_ampersands(investor, monkeypatch):
    pid = investor
    install(monkeypatch, Recorded(chart_down=True))
    cleaned = watch._clean_pick(watch.SearchPick("m&m.ns", ticker="M&M"))
    assert (cleaned.yahoo_symbol, cleaned.ticker) == ("M&M.NS", "M&M")
    brk = run(pid, watch.add, pick=watch.SearchPick("BRK-B", ticker="BRK/B", asset_class="equity"))
    with get_session() as s:
        row = s.get(InvInstrument, brk.item.instrument_id)
        assert (row.symbol, row.currency) == ("BRK/B", "USD")  # a US listing, unverified
    assert aliases(brk.item.instrument_id)["yahoo"] == ("BRK-B", True)


def test_a_concurrent_pick_of_the_same_listing_reuses_the_other_instrument(investor, monkeypatch):
    pid = investor
    install(monkeypatch)
    original = watch._verify
    rival: list[int] = []

    def verify_then_race(symbol, remote):
        quote = original(symbol, remote)
        with get_session() as other:  # another tab stores the same listing meanwhile
            row = instruments.insert(
                other,
                Instrument(
                    id="rival",
                    name="Rival",
                    currency=Currency.USD,
                    asset_class=AssetClass.ETF,
                    symbol="VWRA",
                    aliases=(instruments.InstrumentAlias("yahoo", "VWRA.L"),),
                ),
            )
            rival.append(row.id)
        return quote

    monkeypatch.setattr(watch, "_verify", verify_then_race)
    with get_session() as s:
        before = len(s.exec(select(InvInstrument.id)).all())
    added = run(pid, watch.add, pick=watch.SearchPick("VWRA.L"))
    assert (added.item.instrument_id, added.created_instrument) == (rival[0], False)
    with get_session() as s:
        assert len(s.exec(select(InvInstrument.id)).all()) == before + 1  # only the rival
    assert bar_count(rival[0]) == 0
