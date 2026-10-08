"""Macro regime cards (P6) against a real DB and the API: ``GET /research/macro`` (shape, order, state
after hysteresis, since, history, pl-PL metric text, a missing card), the per-(as_of, data version)
cache, macro notes (the ``macro_*`` keys: note target only, P5 note rules, read marks, ``segment``
filter, never an attribution row, counted in the weekly segment budget), macro keys refused as
instrument segments, the run scope, and the review digest's ``macro_changes``. Synthetic data only."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import STRATEGY_YAML, add_account, canonical_csv, import_file, make_profile
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro import service as macro_service
from cashu.modules.investments.models import InvInstrument
from cashu.modules.investments.research import service, views
from cashu.modules.investments.research.segments import (
    MACRO_KEYS,
    NOT_INSTRUMENT_SEGMENT,
    is_macro_key,
    is_note_segment,
    is_segment,
    macro_catalog,
    regime_of,
    segment_label,
)
from cashu.modules.investments.research.validation import (
    ResearchInputError,
    RunScope,
    validate_note,
    validate_scope,
)
from cashu.modules.investments.service import files
from cashu.modules.investments.store import macro as macro_store

TODAY = dt.date.today()  # noqa: DTZ011 - the endpoint evaluates as of today
JUMP = 30  # the 10-year yield jumps this many sessions before the last one


def sessions(start: dt.date, end: dt.date) -> list[dt.date]:
    out, day = [], start
    while day <= end:
        if day.weekday() < 5:
            out.append(day)
        day += dt.timedelta(days=1)
    return out


DAYS = sessions(TODAY - dt.timedelta(days=800), TODAY)


def seed_macro(*, skip: tuple[str, ...] = ("dbc",)) -> None:
    """ACWI rising (bull), DXY flat, EEM = half of ACWI (inline), no DBC (missing), the 10-year yield
    4.20 -> 4.70 ``JUMP`` sessions ago (rising since then), bills at 4.00 (curve positive)."""
    n = len(DAYS)
    shapes = {
        "acwi": [100 + 0.05 * i for i in range(n)],
        "spx": [5000 + 2.0 * i for i in range(n)],
        "dxy": [100.0] * n,
        "eem": [(100 + 0.05 * i) / 2 for i in range(n)],
        "dbc": [20.0] * n,
        "us10y": [4.2] * (n - JUMP) + [4.7] * JUMP,
        "us3m": [4.0] * n,
    }
    now = utcnow()
    with get_session() as s:
        for key, values in shapes.items():
            if key not in skip:
                macro_store.upsert(
                    s, key, [(d, f"{v:.4f}") for d, v in zip(DAYS, values)], source="test", now=now
                )


def setup_investor(name: str = "Makro") -> tuple[int, str]:
    pid, slug = make_profile(name)
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


@pytest.fixture
def api(api_empty):
    macro_service.clear_cache()
    pid, slug = setup_investor()
    seed_macro()
    return api_empty, pid, f"/api/p/{slug}/investments"


def raw(n: int, **changes) -> dict:
    data = {
        "kind": "macro",
        "polarity": "neutral",
        "strength": 1,
        "title": f"Rentowności USA w górę {n}",
        "summary": "Rentowność 10-letnich obligacji USA wzrosła w kwartale o 50 pb (dane Treasury).",
        "sources": [
            {
                "url": f"https://example.com/p6/{n}",
                "publisher": "Example Treasury",
                "published_at": utcnow().date().isoformat(),
            }
        ],
    }
    data.update(changes)
    return data


def macro_note(pid: int, n: int, segment: str = "macro_rates", run_id=None, **changes) -> int:
    with get_session() as s:
        data = validate_note(raw(n, segment=segment, **changes), now=utcnow())
        return service.add_note(s, s.get(Profile, pid), data, run_id=run_id).note.id


def iid(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


# --------------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------------- #


def test_macro_keys_are_note_targets_only():
    assert MACRO_KEYS == (
        "macro_risk",
        "macro_dollar",
        "macro_em",
        "macro_commodities",
        "macro_rates",
    )
    for key in MACRO_KEYS:
        assert is_macro_key(key) and is_note_segment(key) and not is_segment(key)
        assert segment_label(key) == rg.LABELS[regime_of(key)]
    assert regime_of("gold") is None and not is_macro_key("gold") and is_note_segment("gold")
    assert [r["segment"] for r in macro_catalog()] == list(MACRO_KEYS)
    assert {r["group"] for r in macro_catalog()} == {"macro"}


# --------------------------------------------------------------------------- #
# GET /research/macro
# --------------------------------------------------------------------------- #

CARD_KEYS = {
    "key",
    "label",
    "state",
    "state_label",
    "tone",
    "since",
    "since_open",
    "since_min",
    "as_of",
    "stale",
    "missing",
    "flags",
    "meaning",
    "metrics",
    "history",
    "note",
    "last_note_at",
    "note_this_week",
    "unread",
}


def test_macro_endpoint_shape(api):
    client, _pid, base = api
    body = client.get(f"{base}/research/macro").json()
    assert body["as_of"] == DAYS[-1].isoformat()  # the newest bar, not the request day
    cards = body["regimes"]
    assert [c["key"] for c in cards] == ["risk", "dollar", "em", "commodities", "rates"]
    assert all(set(c) == CARD_KEYS for c in cards)
    by = {c["key"]: c for c in cards}
    risk = by["risk"]
    assert (risk["label"], risk["state"], risk["state_label"], risk["tone"]) == (
        "Rynek akcji",
        "bull",
        "hossa",
        "pos",
    )
    assert risk["as_of"] == DAYS[-1].isoformat() and risk["stale"] is False
    # bull since the first evaluated session: open-ended
    assert risk["since"] is None and risk["since_open"] is True
    assert risk["since_min"] == DAYS[rg.MIN_BARS - 1].isoformat()
    assert [m["label"] for m in risk["metrics"]] == [
        "ACWI wobec 200 sesji",
        "od szczytu",
        "S&P 500 od szczytu",
    ]
    assert risk["metrics"][1] == {
        "label": "od szczytu",
        "value": 0.0,
        "unit": "pct",
        "text": "0,0 %",
        "stale": False,
    }
    assert by["dollar"]["state"] == "flat" and by["dollar"]["tone"] == ""
    assert by["em"]["state_label"] == "w linii"
    commodities = by["commodities"]
    assert commodities["missing"] is True and commodities["state"] == "unknown"
    assert commodities["state_label"] == "brak danych" and commodities["metrics"] == []
    assert commodities["since"] is None and commodities["as_of"] is None
    assert commodities["since_open"] is False and commodities["since_min"] is None
    assert commodities["stale"] is True and commodities["history"] == []
    rates = by["rates"]
    assert (rates["state"], rates["state_label"], rates["tone"]) == (
        "rising",
        "rentowności rosną",
        "warn",
    )
    assert rates["since"] == DAYS[-JUMP].isoformat() and rates["flags"] == []
    assert rates["since_open"] is False and rates["since_min"] is None
    assert rates["history"] == [
        {
            "date": DAYS[rg.MIN_BARS - 1].isoformat(),
            "state": "stable",
            "state_label": "rentowności stabilne",
            "open": True,
        },
        {
            "date": DAYS[-JUMP].isoformat(),
            "state": "rising",
            "state_label": "rentowności rosną",
            "open": False,
        },
    ]
    curve = round((4.7 - rg.bond_equivalent(4.0)) * 100, 6)
    assert rates["metrics"] == [
        {"label": "USA 10 lat", "value": 4.7, "unit": "level", "text": "4,70 %", "stale": False},
        {"label": "3 mies. zmiana", "value": 50.0, "unit": "bp", "text": "+50 bp", "stale": False},
        {"label": "krzywa 10l-3m", "value": curve, "unit": "bp", "text": "+60 bp", "stale": False},
    ]
    assert rates["meaning"] == rg.MEANINGS["rates"]["rising"]
    assert all(c["note"] is None and c["last_note_at"] is None for c in cards)
    assert all(c["note_this_week"] is False and c["unread"] == 0 for c in cards)


def test_macro_view_without_any_data(api_empty):
    macro_service.clear_cache()
    _pid, slug = setup_investor("Pusto")
    body = api_empty.get(f"/api/p/{slug}/investments/research/macro").json()
    cards = body["regimes"]
    assert len(cards) == 5 and all(c["missing"] and c["stale"] for c in cards)
    assert body["as_of"] is None


def test_regimes_are_cached_per_data_version(api, monkeypatch):
    _client, _pid, _base = api
    calls: list[dt.date] = []
    original = rg.evaluate

    def counting(closes, as_of):
        calls.append(as_of)
        return original(closes, as_of)

    monkeypatch.setattr(rg, "evaluate", counting)
    macro_service.clear_cache()
    with get_session() as s:
        first = macro_service.regimes(s)
        assert macro_service.regimes(s) is first and len(calls) == 1
        macro_service.regimes(s, TODAY - dt.timedelta(days=1))
        assert len(calls) == 2
    with get_session() as s:
        macro_store.upsert(s, "dbc", [(DAYS[-1], "21")], source="test", now=utcnow())
    with get_session() as s:
        assert macro_service.regimes(s) is not first and len(calls) == 3


# --------------------------------------------------------------------------- #
# Macro notes
# --------------------------------------------------------------------------- #


def test_macro_note_on_the_card_read_marks_and_filter(api):
    client, pid, base = api
    nid = macro_note(pid, 1)
    cards = {c["key"]: c for c in client.get(f"{base}/research/macro").json()["regimes"]}
    rates = cards["rates"]
    assert rates["note"]["id"] == nid and rates["note"]["kind"] == "macro"
    assert set(rates["note"]) == {"id", "title", "observed_at", "kind", "polarity"}
    assert rates["last_note_at"] == rates["note"]["observed_at"]
    assert rates["note_this_week"] is True and rates["unread"] == 1
    assert cards["dollar"]["note"] is None
    rows = client.get(f"{base}/research?segment=macro_rates").json()
    assert [r["id"] for r in rows] == [nid] and rows[0]["segment_label"] == "Obligacje i stopy"
    assert client.get(f"{base}/research?segment=macro_nope").status_code == 422
    # never an attribution row
    segments = client.get(f"{base}/research/segments").json()["segments"]
    assert all(not is_macro_key(r["segment"]) for r in segments)
    summary = client.get(f"{base}/research/summary").json()
    assert summary["totals"]["notes_unread"] == 1
    assert client.post(f"{base}/research/read", json={"segment": "macro_rates"}).json() == {
        "marked": 1
    }
    rates = client.get(f"{base}/research/macro").json()["regimes"][4]
    assert rates["unread"] == 0 and rates["note"]["id"] == nid
    # dismissed: off the card, still the last note date
    client.patch(f"{base}/research/{nid}", json={"dismissed": True})
    rates = client.get(f"{base}/research/macro").json()["regimes"][4]
    assert rates["note"] is None and rates["last_note_at"] is None


def test_macro_note_rules(api):
    _client, pid, _base = api
    macro_note(pid, 1)
    with pytest.raises(service.ResearchConflict, match="already has a note this week"):
        macro_note(pid, 2)
    macro_note(pid, 3, segment="macro_dollar", kind="news")
    macro_note(pid, 4, segment="macro_em", kind="trend")
    with pytest.raises(ResearchInputError, match="segment note is one of"):
        validate_note(raw(5, segment="macro_risk", kind="earnings"), now=utcnow())
    with pytest.raises(ResearchInputError, match="too long for a segment note"):
        validate_note(raw(6, segment="macro_risk", summary="x" * 401), now=utcnow())
    with pytest.raises(ResearchInputError, match="thesis"):
        validate_note(raw(7, segment="macro_risk", thesis_relation="supports"), now=utcnow())
    with get_session() as s, pytest.raises(service.ResearchError):
        data = validate_note(raw(8, segment="macro_risk"), now=utcnow())
        service.add_note(s, s.get(Profile, pid), data, instrument_id=iid("XMPL"))


def test_macro_notes_count_in_the_weekly_segment_budget(api):
    _client, pid, _base = api
    with get_session() as s:
        run_id = service.start_run(s, s.get(Profile, pid), RunScope(held=True)).id
    for n, key in enumerate(MACRO_KEYS, start=1):
        macro_note(pid, n, segment=key, run_id=run_id)
    macro_note(pid, 6, segment="gold", run_id=run_id)
    assert service.WEEKLY_SEGMENT_NOTES_MAX == 6
    with pytest.raises(service.ResearchConflict, match="6 segment notes"):
        macro_note(pid, 7, segment="bonds", run_id=run_id)


def test_strength_3_macro_note_signal_uses_the_card_title(api):
    _client, pid, _base = api
    nid = macro_note(pid, 1, strength=3)
    with get_session() as s:
        rows = service.notes(s, pid, segment="macro_rates")
        assert [r.id for r in rows] == [nid] and rows[0].signal_id is not None
        view = views.notes_view(s, s.get(Profile, pid), rows)[0]
    assert view["segment"] == "macro_rates" and view["segment_label"] == "Obligacje i stopy"


def test_scope_accepts_macro_keys_on_demand():
    scope = validate_scope({"segments": ["macro_rates", "gold", "macro_rates"]})
    assert scope.segments == ("macro_rates", "gold")
    assert (scope.held, scope.watchlist, scope.candidates) == (False, False, False)
    with pytest.raises(ResearchInputError):
        validate_scope({"segments": ["macro_bogus"]})


def test_macro_keys_are_refused_as_instrument_segments(api):
    client, _pid, base = api
    answer = client.patch(f"{base}/instruments/{iid('ABC')}", json={"segment": "macro_rates"})
    assert answer.status_code == 422 and answer.json()["detail"] == NOT_INSTRUMENT_SEGMENT
    assert (
        client.patch(f"{base}/instruments/{iid('ABC')}", json={"segment": "gold"}).status_code
        == 200
    )


# --------------------------------------------------------------------------- #
# Review digest
# --------------------------------------------------------------------------- #


def test_digest_macro_changes(api):
    _client, pid, _base = api
    with get_session() as s:
        changed = views.research_digest(s, pid, TODAY - dt.timedelta(days=90))["macro_changes"]
        assert changed == [
            {
                "key": "rates",
                "label": "Obligacje i stopy",
                "from_label": "rentowności stabilne",
                "to_label": "rentowności rosną",
                "since": DAYS[-JUMP].isoformat(),
            }
        ]
        assert views.research_digest(s, pid, TODAY - dt.timedelta(days=10))["macro_changes"] == []
        # as of a day before the jump nothing had changed yet
        before = DAYS[-JUMP - 1]
        assert (
            views.research_digest(s, pid, before - dt.timedelta(days=30), as_of=before)[
                "macro_changes"
            ]
            == []
        )


def test_changes_skip_a_flip_back_and_unknown_starts(db_engine):
    macro_service.clear_cache()
    n = len(DAYS)
    # 10 sessions at 4.7: rising from n-80, stable from n-70, the echo of the jump 63 sessions later
    # falling from n-17, stable again from n-7
    values = [4.2] * (n - 80) + [4.7] * 10 + [4.2] * 70
    with get_session() as s:
        macro_store.upsert(
            s, "us10y", [(d, f"{v:.3f}") for d, v in zip(DAYS, values)], source="t", now=utcnow()
        )
    with get_session() as s:
        history = macro_service.regimes(s)[4].history
        assert [(h.date, h.state) for h in history[-4:]] == [
            (DAYS[-80], "rising"),
            (DAYS[-70], "stable"),
            (DAYS[-17], "falling"),
            (DAYS[-7], "stable"),
        ]
        assert macro_service.changes(s, DAYS[-85]) == []  # stable -> ... -> stable
        assert macro_service.changes(s, DAYS[-12]) == [
            {
                "key": "rates",
                "label": "Obligacje i stopy",
                "from_label": "rentowności spadają",
                "to_label": "rentowności stabilne",
                "since": DAYS[-7].isoformat(),
            }
        ]
        # a period starting before the stored window: the state before it is unknown
        assert macro_service.changes(s, DAYS[0]) == []


def test_digest_survives_a_failing_macro_view(api, monkeypatch):
    _client, pid, _base = api

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(macro_service, "changes", broken)
    with get_session() as s:
        assert views.research_digest(s, pid, TODAY - dt.timedelta(days=7))["macro_changes"] == []


def test_since_does_not_slide_with_the_request_day(api):
    _client, _pid, _base = api
    with get_session() as s:
        for as_of in (DAYS[-1], DAYS[-2], DAYS[-22]):  # today, a day earlier, a month earlier
            risk, *_rest, rates = macro_service.regimes(s, as_of)
            assert rates.since == DAYS[-JUMP] and not rates.since_open
            assert risk.since is None and risk.since_open
            assert risk.since_min == DAYS[rg.MIN_BARS - 1]


def test_a_switch_straddling_two_digest_periods_shows_exactly_once(api):
    _client, pid, _base = api
    started, confirmed = DAYS[-JUMP], DAYS[-JUMP + 4]
    with get_session() as s:
        # last week's digest ends after the run began but before the switch was visible
        first = views.research_digest(
            s, pid, started - dt.timedelta(days=7), as_of=DAYS[-JUMP + 2]
        )["macro_changes"]
        # this week's digest starts inside the run, before the confirmation
        second = views.research_digest(s, pid, DAYS[-JUMP + 3], as_of=DAYS[-1])["macro_changes"]
    assert first == []
    assert [(c["key"], c["since"]) for c in second] == [("rates", started.isoformat())]
    assert DAYS[-JUMP + 3] <= confirmed
