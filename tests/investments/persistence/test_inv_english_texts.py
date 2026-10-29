"""Investments texts in English (localization): calendar titles rendered from the cached English feed
title, segment labels, the module's setup steps, the default review name and the research draft
thesis prefix. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from invp_support import make_profile

from cashu.core.db import get_session
from cashu.core.i18n import use_language
from cashu.core.models import Profile
from cashu.modules.investments.market import calendar
from cashu.modules.investments.models import InvInstrument, InvInstrumentAlias, InvWatchlistItem
from cashu.modules.investments.research import service as research_service
from cashu.modules.investments.research.segments import catalog, segment_label
from cashu.modules.investments.setup import setup_status
from cashu.modules.investments.strategy.config import ReviewPolicy

TODAY = dt.date(2026, 11, 1)


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(calendar, "cache_path", lambda: tmp_path / "market" / calendar.CACHE_FILE)


def test_the_cache_keeps_polish_titles_and_the_view_renders_english(db_engine):
    body = json.dumps(
        [
            {"title": "Federal Funds Rate", "country": "USD", "date": "2026-11-04T14:00:00-04:00", "impact": "High"},
            {"title": "CPI y/y", "country": "EUR", "date": "2026-11-03T05:00:00-05:00", "impact": "High"},
        ]
    )
    with use_language("en"):
        rows = calendar.parse_ff(body)
    assert [r["title"] for r in rows] == ["Fed: decyzja o stopach", "inflacja CPI"]

    anna, _ = make_profile("Anna")
    with get_session() as s:
        row = InvInstrument(name="Przyklad Corp", currency="USD", asset_class="equity", symbol="XMPL", valuation_mode="market")
        s.add(row)
        s.flush()
        s.add(InvInstrumentAlias(instrument_id=row.id, namespace="yahoo", value="XMPL"))
        s.add(InvWatchlistItem(profile_id=anna, instrument_id=row.id, note=None, tags=[]))
        s.commit()
    feed = {
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(),
        "from": TODAY.isoformat(),
        "to": (TODAY + dt.timedelta(14)).isoformat(),
        "macro": rows,
        "earnings": [{"date": "2026-11-03", "symbol": "XMPL", "name": "Przyklad Corp", "when": "pre"}],
        "errors": [],
    }
    with get_session() as s, use_language("en"):
        view = calendar.calendar_view(s, s.get(Profile, anna), today=TODAY, fetch=lambda t, d: feed)
    by_kind = {(e["kind"], e["country"]): e for e in view["events"]}
    assert by_kind[("macro", "USD")]["title"] == "Fed: rate decision"
    assert by_kind[("macro", "USD")]["country_label"] == "US"
    assert by_kind[("macro", "EUR")]["title"] == "CPI inflation"
    assert by_kind[("macro", "EUR")]["country_label"] == "euro area"
    earning = by_kind[("earnings", None)]
    assert earning["title"] == "Quarterly results XMPL" and earning["time"] == "before the open"


def test_segment_labels_in_english():
    with use_language("en"):
        assert segment_label("semis_ai") == "AI: chips and data centers"
        assert segment_label("unassigned") == "No topic"
        assert segment_label("macro_rates") == "Bonds and rates"
        assert {r["segment"]: r["label"] for r in catalog()}["equity_global"] == "Global equities"
    assert segment_label("semis_ai") == "AI: chipy i centra danych"


def test_setup_steps_in_english(db_engine):
    anna, _ = make_profile("Anna")
    with get_session() as s, use_language("en"):
        steps = setup_status(s, anna).steps
    assert [st.title for st in steps] == [
        "Add a brokerage account",
        "Save the strategy",
        "First contribution or import",
        "First rules run",
    ]
    assert steps[0].actions[0].label == "Copy command"
    assert steps[2].actions[0].target.endswith("invest import FILE.csv --account ACCOUNT_ID")


def test_default_review_name_in_english():
    with use_language("en"):
        assert ReviewPolicy().title == "Weekly review"
        assert ReviewPolicy(every="month").title == "Monthly review"
        assert ReviewPolicy(name="Moja niedziela").title == "Moja niedziela"
    assert ReviewPolicy(every="2weeks").title == "Przegląd dwutygodniowy"


def test_both_draft_prefixes_are_recognised():
    assert research_service.DRAFT_THESIS_PREFIX in research_service.DRAFT_THESIS_PREFIXES
    assert research_service.DRAFT_THESIS_PREFIX_EN in research_service.DRAFT_THESIS_PREFIXES
    assert "Research draft: AI chips".startswith(research_service.DRAFT_THESIS_PREFIXES)
