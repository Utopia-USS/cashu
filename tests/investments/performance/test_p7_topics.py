"""Topics (P7), pure parts: snapshot-held positions count as held at the window start
(``snapshot_openings``), the topic trend independent of holdings weight (``segment_trends``:
equal weight, held and watched alike, missing / stale / same-bar closes left out) and the catalog
rename ``uranium`` -> ``power``. Synthetic input only."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from perf_support import bars, day

from cashu.modules.investments.domain import (
    AssetClass,
    Instrument,
    Transaction,
    TxnSource,
    TxnType,
)
from cashu.modules.investments.performance.segment_attribution import (
    TREND_WINDOWS,
    member_return,
    segment_trends,
    snapshot_openings,
)
from cashu.modules.investments.portfolio import build_snapshot
from cashu.modules.investments.research.segments import (
    FUND_SEGMENTS,
    LEGACY_KEYS,
    SEGMENT_KEYS,
    auto_segment,
    segment_label,
    segment_of,
)

START, END = day("2026-10-01"), day("2026-10-08")


def txn(
    n: int,
    when: str,
    *,
    kind: TxnType = TxnType.ADJUSTMENT,
    source: TxnSource = TxnSource.RECONCILIATION,
    instrument: str = "BTC",
    account: str = "1",
    quantity: str = "0.5",
) -> Transaction:
    return Transaction(
        id=f"t{n}",
        account_id=account,
        type=kind,
        trade_date=day(when),
        currency="USD",
        gross_amount=Decimal(0),
        cash_amount=Decimal(0),
        cash_currency="USD",
        instrument_id=instrument,
        quantity=Decimal(quantity),
        source=source,
        created_at=dt.datetime(2026, 10, 8, tzinfo=dt.UTC) + dt.timedelta(seconds=n),
    )


def held(txns: list[Transaction], on: dt.date) -> dict[str, Decimal]:
    snapshot = build_snapshot("1", txns, on)
    return {h.instrument_id: h.quantity for h in snapshot.holdings}


# --------------------------------------------------------------------------- #
# Snapshot-held positions
# --------------------------------------------------------------------------- #


def test_a_snapshot_opening_inside_the_window_counts_as_held_at_start():
    opening = txn(1, "2026-10-06")  # the broker snapshot of 6 Oct, imported this week
    moved = snapshot_openings([opening], START)
    assert moved[0].trade_date == START and moved[0].settle_date is None
    assert held(moved, START) == {"BTC": Decimal("0.5")}
    assert held([opening], START) == {}  # what the history alone says


def test_an_opening_before_the_window_and_real_history_keep_their_dates():
    before = txn(1, "2026-09-20")
    assert snapshot_openings([before], START) == [before]
    # a real buy first: the history is the information, the later correction stays where it is
    buy = txn(2, "2026-10-03", kind=TxnType.BUY, source=TxnSource.IMPORT, instrument="ETH")
    fix = txn(3, "2026-10-06", instrument="ETH")
    assert snapshot_openings([buy, fix], START) == [buy, fix]
    # a later correction of a snapshot-held position is a real change reported by the broker
    later = txn(4, "2026-10-07", instrument="SOL")
    first = txn(5, "2026-10-05", instrument="SOL")
    out = snapshot_openings([later, first], START)
    assert [t.trade_date for t in out] == [day("2026-10-07"), START]


def test_openings_are_per_account_and_a_transfer_out_is_never_moved():
    other_account = txn(1, "2026-10-06", account="2")
    real = txn(2, "2026-09-01", kind=TxnType.BUY, source=TxnSource.IMPORT)
    out = snapshot_openings([real, other_account], START)
    assert out[1].trade_date == START  # account 2 knows BTC only from its snapshot
    surplus = txn(3, "2026-10-06", kind=TxnType.TRANSFER_OUT, instrument="ADA")
    assert snapshot_openings([surplus], START) == [surplus]


def test_a_coin_first_reported_by_a_later_snapshot_is_a_new_position():
    """BTC in the account's first snapshot of 1 Sep; ETH bought 5 Oct and first reported by the
    snapshot of 6 Oct: the earlier snapshot without ETH is the information, so ETH keeps its date."""
    btc = txn(1, "2026-09-01")
    eth = txn(2, "2026-10-06", instrument="ETH", quantity="2")
    out = snapshot_openings([btc, eth], START)
    assert out == [btc, eth]
    assert held(out, START) == {"BTC": Decimal("0.5")}
    # the first snapshot of a snapshot-only account imported this week still moves (both coins)
    first_btc, first_eth = txn(3, "2026-10-06"), txn(4, "2026-10-06", instrument="ETH")
    moved = snapshot_openings([first_btc, first_eth], START)
    assert held(moved, START) == {"BTC": Decimal("0.5"), "ETH": Decimal("0.5")}
    # an account with a real history: an old holding reported by its first snapshot moves, a coin
    # reported only by a later snapshot does not
    buy = txn(5, "2026-03-01", kind=TxnType.BUY, source=TxnSource.IMPORT, instrument="SOL")
    old = txn(6, "2026-10-03", instrument="ADA")
    new = txn(7, "2026-10-07", instrument="DOT")
    out = snapshot_openings([buy, old, new], START)
    assert [t.trade_date for t in out] == [day("2026-03-01"), START, day("2026-10-07")]


# --------------------------------------------------------------------------- #
# Topic trends
# --------------------------------------------------------------------------- #

CLOSES = {
    # +10 % over 1w, +21 % over 4w
    "A": bars("A", {"2026-09-10": 100, "2026-10-01": 110, "2026-10-08": 121}),
    # -10 % over 1w; no close 28 days back
    "B": bars("B", {"2026-10-01": 50, "2026-10-08": 45}),
    # last close 6 days old: stale for both windows
    "C": bars("C", {"2026-09-10": 10, "2026-10-01": 10, "2026-10-02": 12}),
    # quantum, watched only: +30 % over 1w
    "Q": bars("Q", {"2026-10-01": 10, "2026-10-08": 13}),
}


def test_trend_is_equal_weighted_over_held_and_watched_members():
    members = {
        "A": ("semis_ai", True),
        "B": ("semis_ai", False),
        "C": ("semis_ai", True),
        "Q": ("quantum", False),
        "N": ("quantum", False),  # no bars at all
    }
    found = segment_trends(members, CLOSES, END, max_price_age_days=5)
    assert TREND_WINDOWS == (7, 28)
    ai = found["semis_ai"]
    assert ai.trends[0] == 0.0  # (+10 % - 10 %) / 2, whatever the weights; C is stale
    assert round(ai.trends[1], 6) == 0.21  # only A has a 4w close
    assert ai.members == 2
    assert [m.instrument_id for m in ai.instruments] == ["A", "C", "B"]  # held first, priced first
    quantum = found["quantum"]
    assert round(quantum.trends[0], 6) == 0.3 and quantum.trends[1] is None
    assert quantum.members == 1 and {m.held for m in quantum.instruments} == {False}


def test_a_segment_without_any_price_has_no_trend():
    found = segment_trends({"N": ("crypto", True)}, {}, END)
    assert found["crypto"].trends == (None, None) and found["crypto"].members == 0


def test_member_return_rules():
    assert round(member_return(CLOSES["A"], END, 7, 5), 9) == 0.1
    assert member_return(CLOSES["C"], END, 7, 5) is None  # end close 6 days old
    same = bars("S", {"2026-09-28": 10})
    assert member_return(same, END, 7, 5) is None  # one bar for both ends (and stale)
    one = bars("S", {"2026-10-08": 10})
    assert member_return(one, END, 7, 5) is None  # no close at the window start
    old_start = bars("S", {"2026-09-20": 10, "2026-10-08": 11})
    assert member_return(old_start, END, 7, 5) is None  # start close 11 days before the start


# --------------------------------------------------------------------------- #
# Catalog rename
# --------------------------------------------------------------------------- #


def test_the_owner_topics_labels_and_the_power_rename():
    labels = {
        "semis_ai": "AI: chipy i centra danych",
        "software": "AI i oprogramowanie",
        "quantum": "Komputery kwantowe",
        "power": "Energetyka: atom i OZE",
        "energy": "Ropa i gaz",
        "metals": "Metale i ziemie rzadkie",
        "games_media": "Gry",
        "financials": "Płatności i finanse",
        "gold": "Złoto i górnicy",
    }
    assert {k: segment_label(k) for k in labels} == labels
    assert "uranium" not in SEGMENT_KEYS and LEGACY_KEYS == {"uranium": "power"}
    assert {FUND_SEGMENTS[s] for s in ("URA", "URNM", "URNU", "NUKZ")} == {"power"}
    etf = Instrument(
        id="1", name="Example", currency="USD", asset_class=AssetClass.ETF, symbol="URA"
    )
    assert auto_segment(etf) == "power"
    stock = Instrument(id="2", name="Example", currency="USD", asset_class=AssetClass.EQUITY)
    assert segment_of(stock, "uranium", "agent") == ("power", "agent")  # an old stored value
    assert segment_of(stock, "dropped_key") == (None, None)
