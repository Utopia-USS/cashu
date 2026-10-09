"""Topics (P7) against a real DB and the API: a crypto account known only from a broker position
snapshot (positions-only import, correction applied this week, priced in USD) is held at the window
start, never a new position; watched-only topics are rows with their equal-weighted trend after the
rows with exposure; the dollar card folds in the portfolio's weekly currency effect. Synthetic data
only."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from invp_support import HEADER, add_account
from test_p5_segments_service import TODAY, _d, _moving_portfolio, _view, iid, watch
from test_p6_macro_api import seed_macro

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.domain import PriceBar
from cashu.modules.investments.importing.contract import ImportFile
from cashu.modules.investments.macro import service as macro_service
from cashu.modules.investments.service import imports
from cashu.modules.investments.store import instruments as instrument_store
from cashu.modules.investments.store import market

START = TODAY - dt.timedelta(days=7)
DAYS = [TODAY - dt.timedelta(days=i) for i in range(40, -1, -1)]


def _bars(instrument_id: int, before: float, after: float) -> None:
    with get_session() as s:
        market.upsert_bars(
            s,
            [
                PriceBar(
                    str(instrument_id), d, Decimal(str(before if d <= START else after)), "test"
                )
                for d in DAYS
            ],
            now=utcnow(),
        )


def _snapshot_only_crypto(pid: int) -> int:
    """A crypto account whose only record is a broker position snapshot of 2 days ago (BTC 0.5,
    USD), imported with the proposed correction applied; BTC 60 000 -> 66 000 USD in the window."""
    aid = add_account(pid, name="Krypto", broker="zonda")
    content = "\n".join([HEADER, f"1,position,{_d(2)},,,,BTC,,Bitcoin,,0.5,,USD,,,,,,,,"]) + "\n"
    with get_session() as s:
        preview = imports.preview(
            s,
            s.get(Profile, pid),
            imports.ImportRequest(ImportFile("pozycje.csv", content.encode("utf-8")), aid),
        )
    (diff,) = preview.reconciliation.mismatches
    assert imports.commit(preview, corrections=[diff.instrument_id]).corrections == 1
    btc = iid("BTC")
    with get_session() as s:
        instrument_store.classify(s, btc, profile_id=pid, asset_class="crypto")
    _bars(btc, 60000, 66000)
    return btc


def test_a_snapshot_only_crypto_holding_is_held_at_the_start(db_engine):
    pid, _ = _moving_portfolio()
    btc = _snapshot_only_crypto(pid)
    view = _view(pid)
    rows = {r["segment"]: r for r in view["segments"]}
    assert view["new_positions"] == 1  # XMPL bought mid-window; BTC is not new
    crypto = rows["crypto"]
    # T0 = 20 000 + 0.5 x 60 000 USD x 4.0 = 140 000; BTC +10 % in USD, USD flat
    assert crypto["weight"] == round(120000 / 140000, 6)
    assert crypto["contribution"] == round(12000 / 140000, 6) and crypto["return"] == 0.1
    assert [i["instrument_id"] for i in crypto["instruments"]] == [btc]
    assert (crypto["trend_1w"], crypto["members"]) == (0.1, 1)
    assert view["segments"][0]["segment"] == "crypto"  # the largest |contribution|
    assert btc not in view["stale"]


def test_watched_only_topics_are_rows_after_the_exposed_ones(db_engine):
    pid, _ = _moving_portfolio()
    ionq, rgti, nopx = watch(pid, "IONQ.US"), watch(pid, "RGTI.US"), watch(pid, "QBTS.US")
    oil = watch(pid, "XOM.US")
    with get_session() as s:
        for instrument, segment in ((ionq, "quantum"), (rgti, "quantum"), (nopx, "quantum")):
            instrument_store.set_segment(s, instrument, segment, profile_id=pid, by="owner")
        instrument_store.set_segment(s, oil, "energy", profile_id=pid, by="agent")
    _bars(ionq, 10, 13)  # +30 %
    _bars(rgti, 10, 9)  # -10 %
    _bars(oil, 100, 101)  # +1 %
    view = _view(pid)
    order = [r["segment"] for r in view["segments"]]
    assert order[:3] == ["equity_pl", "equity_global", "bonds"]  # exposure, by |contribution|
    assert order[3:] == ["quantum", "energy"]  # then |trend_1w|
    quantum = view["segments"][3]
    assert (quantum["weight"], quantum["contribution"], quantum["return"]) == (0.0, 0.0, None)
    assert (
        quantum["trend_1w"] == 0.1 and quantum["members"] == 2
    )  # (+30 % - 10 %) / 2; QBTS no bars
    assert quantum["instruments"] == []
    members = {m["label"]: m for m in quantum["member_instruments"]}
    assert set(members) == {"IONQ", "RGTI", "QBTS"}
    assert members["IONQ"]["held"] is False and members["QBTS"]["return_1w"] is None
    # a held topic with exposure gets the trend of its held members (equal weight)
    pl = view["segments"][0]
    assert (pl["trend_1w"], pl["members"]) == (0.1, 1)
    assert view["segments"][2]["trend_1w"] is None  # a treasury bond at cost has no bars


def test_the_dollar_card_folds_in_the_weekly_currency_effect(db_engine):
    macro_service.clear_cache()
    pid, _ = _moving_portfolio()
    seed_macro()
    with get_session() as s:
        cards = macro_service.macro_view(s, s.get(Profile, pid))["regimes"]
    dollar = next(c for c in cards if c["key"] == "dollar")
    # EUR +10 % on 20 % of T0 = +1,8 pp (the 1w attribution); USD/PLN flat at 4.0
    assert dollar["summary"].startswith("Dolar bez wyraźnego trendu ")
    assert dollar["summary"].endswith(
        "W tym tygodniu USD/PLN 0,0 %, a kursy walut dodały portfelowi 1,8 pp."
    )
    assert dollar["explain"].endswith(dollar["meaning"])
    risk = next(c for c in cards if c["key"] == "risk")
    assert risk["summary"].startswith("Akcje na świecie rosną co najmniej od ")
    assert risk["summary"].endswith("są na rocznym szczycie.")
    commodities = next(c for c in cards if c["key"] == "commodities")
    assert commodities["summary"] == "Za mało aktualnych notowań, by opisać ten rynek."


def test_the_review_digest_keeps_topics_with_a_note_this_week(db_engine):
    from test_p5_segments_service import segment_note

    from cashu.modules.investments.research import views

    pid, _ = _moving_portfolio()
    for n, (symbol, segment) in enumerate(
        (("IONQ.US", "quantum"), ("XOM.US", "energy"), ("MP.US", "metals"), ("MSFT.US", "software"))
    ):
        instrument = watch(pid, symbol)
        with get_session() as s:
            instrument_store.set_segment(s, instrument, segment, profile_id=pid, by="owner")
        _bars(instrument, 100, 101 + n)
    segment_note(pid, 1, "crypto")  # no exposure, no member: the last row of the view
    assert [r["segment"] for r in _view(pid)["segments"]][-1] == "crypto"
    with get_session() as s:
        block = views.research_digest(s, pid, utcnow() - dt.timedelta(days=7))
    order = [r["segment"] for r in block["segments"]]
    assert len(order) == 6 and order[0] == "crypto"  # the new note first, then the view's order
    assert order[1:] == ["equity_pl", "equity_global", "bonds", "software", "metals"]
