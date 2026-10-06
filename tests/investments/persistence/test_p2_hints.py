"""P2 backend: strategy hints on positions rows, watchlist rows and the asset detail (rule kinds,
thesis health, plan checks incl. ``plan_vs_thesis`` for watched instruments, triggered alerts), MCP
``positions`` / ``watchlist`` hints identical in strict and full mode (no alert title), and the thesis
health window: a thesis edit never drops research, a core edit tags it (``predates_thesis`` on notes,
the health result and summary rows), an exit-plan edit does not (``core_changed_at``). Synthetic data
only."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
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
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvResearchNote,
    InvSignal,
    InvThesis,
)
from cashu.modules.investments.service import daily, files

STRATEGY = """\
version: 1
base_currency: PLN
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
rules:
  - id: rule_a
    kind: gain_from_cost
    params: { threshold: 0.5 }
  - id: rule_b
    kind: loss_from_cost
    params: { threshold: 0.1 }
  - id: rule_c
    kind: position_concentration
    params: { max_weight: 0.30 }
"""
PRICES = {"ABC.WA": 60, "WRLD.DE": 50, "XMPL": 200}  # XMPL +100 %, WRLD below cost


@pytest.fixture
def api(api_empty):
    pid, slug = make_profile("Inwestor")
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY)
    return api_empty, pid, f"/api/p/{slug}/investments"


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def run() -> daily.DailyCheckReport:
    fake = FakePrices({k: Decimal(v) for k, v in PRICES.items()})
    return daily.run_daily_check("worker", as_of=AS_OF, sources=sources(fake))


def add_note(
    pid: int, iid: int, relation: str, *, stored_ago: dt.timedelta = dt.timedelta(0)
) -> int:
    now = utcnow()
    with get_session() as s:
        row = InvResearchNote(
            profile_id=pid,
            instrument_id=iid,
            kind="news",
            polarity="neutral",
            strength=2,
            thesis_relation=relation,
            thesis_field="thesis",
            title=f"Example fact {relation}",
            summary="Przykladowy fakt ze zrodlem.",
            sources=[],
            observed_at=now - dt.timedelta(hours=1),
            expires_at=now + dt.timedelta(days=30),
            created_by="agent",
            created_at=now - stored_ago,
            updated_at=now - stored_ago,
            read_at=now,
        )
        s.add(row)
        s.commit()
        return row.id


def codes(hints: list[dict]) -> list[str]:
    return [h["code"] for h in hints]


def watch(client, base: str, symbol: str = "VWCE.DE") -> int:
    r = client.post(f"{base}/watchlist", json={"symbol_or_isin": symbol})
    assert r.status_code == 201, r.text
    return r.json()["instrument"]["id"]


def plan_vs_thesis_open(pid: int, iid: int) -> bool:
    with get_session() as s:
        row = s.exec(
            select(InvSignal).where(
                InvSignal.profile_id == pid,
                InvSignal.dedup_key == f"plan:plan_vs_thesis|i:{iid}",
                InvSignal.status.in_(("active", "acknowledged")),
            )
        ).first()
        return row is not None


# --------------------------------------------------------------------------- #
# Held: positions rows and the asset detail
# --------------------------------------------------------------------------- #


def test_positions_rows_carry_rule_kind_and_thesis_hints(api):
    client, pid, base = api
    run()
    rows = client.get(f"{base}/positions").json()["positions"]
    by_symbol = {r["instrument"]["symbol"]: r["hints"] for r in rows}
    xmpl = by_symbol["XMPL"]
    assert codes(xmpl) == ["gain_review", "concentration", "no_thesis"]
    assert xmpl[0] == {
        "code": "gain_review",
        "severity": "review",
        "params": {"gain": 1.0, "threshold": 0.5, "has_exit_plan": False},
    }
    assert xmpl[1]["params"]["max_weight"] == 0.3 and 0.3 < xmpl[1]["params"]["weight"] < 1
    assert xmpl[2] == {"code": "no_thesis", "severity": "review", "params": {}}
    wrld = by_symbol["WRLD"]
    assert codes(wrld) == ["loss_review", "no_thesis"]
    assert wrld[0]["params"]["threshold"] == 0.1 and wrld[0]["params"]["loss"] > 0.1
    assert codes(by_symbol["ABC"]) == ["no_thesis"]

    # a thesis without an exit plan: gain_review carries it (no separate no_exit_plan)
    abc, x = instrument_id("ABC"), instrument_id("XMPL")
    for iid in (abc, x):
        client.post(
            f"{base}/instruments/{iid}/theses",
            json={"entry_type": "trend", "thesis": "Przykladowa teza"},
        )
    rows = client.get(f"{base}/positions").json()["positions"]
    by_symbol = {r["instrument"]["symbol"]: r["hints"] for r in rows}
    assert codes(by_symbol["XMPL"]) == ["gain_review", "concentration"]
    assert codes(by_symbol["ABC"]) == ["no_exit_plan"]

    # a fulfilling note: thesis_fulfilled leads; the asset detail has the row's hints
    add_note(pid, x, "fulfills")
    detail = client.get(f"{base}/positions/{x}").json()
    assert codes(detail["hints"]) == ["thesis_fulfilled", "gain_review", "concentration"]
    assert detail["hints"] == detail["position"]["hints"]
    assert detail["hints"][0]["params"] == {"has_exit_plan": False, "predates_thesis": False}

    # an invalidating note on ABC: the rule-severity hint is the main one
    add_note(pid, abc, "invalidates")
    rows = client.get(f"{base}/positions").json()["positions"]
    abc_hints = next(r for r in rows if r["instrument"]["id"] == abc)["hints"]
    assert abc_hints[0] == {
        "code": "thesis_invalidated",
        "severity": "rule",
        "params": {"predates_thesis": False},
    }


def test_plan_vs_thesis_hint_on_a_held_position(api):
    client, pid, base = api
    abc = instrument_id("ABC")
    client.post(
        f"{base}/instruments/{abc}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza", "exit_plan": "Koniec 2028"},
    )
    client.put(f"{base}/instruments/{abc}/plan", json={"plan": "buy"})
    add_note(pid, abc, "weakens")
    run()
    rows = client.get(f"{base}/positions").json()["positions"]
    hints = next(r for r in rows if r["instrument"]["id"] == abc)["hints"]
    assert hints == [
        # P3: the weakening note was stored after the recommendation
        {
            "code": "recommendation_maybe_outdated",
            "severity": "review",
            "params": {"reasons": ["note_after"]},
        },
        {
            "code": "plan_vs_thesis",
            "severity": "rule",
            "params": {"plan": "buy", "health": "weakened"},
        },
        {"code": "thesis_weakened", "severity": "review", "params": {"predates_thesis": False}},
    ]


# --------------------------------------------------------------------------- #
# Watched: watchlist rows, the asset detail, plan_vs_thesis for watched instruments
# --------------------------------------------------------------------------- #


def test_watched_hints_plan_checks_and_alerts(api):
    client, pid, base = api
    vwce = watch(client, base)
    item = client.get(f"{base}/watchlist").json()[0]
    assert item["hints"] == [{"code": "no_thesis", "severity": "info", "params": {}}]

    client.put(f"{base}/instruments/{vwce}/plan", json={"plan": "buy_asap"})
    hints = client.get(f"{base}/watchlist").json()[0]["hints"]
    assert hints == [
        {"code": "plan_without_thesis", "severity": "rule", "params": {"plan": "buy_asap"}},
        {"code": "no_thesis", "severity": "info", "params": {}},
    ]

    # a thesis, then a weakening note: the daily run opens plan_vs_thesis for the watched instrument
    client.post(
        f"{base}/instruments/{vwce}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    )
    # P3: the thesis was written after the recommendation
    assert client.get(f"{base}/watchlist").json()[0]["hints"] == [
        {
            "code": "recommendation_maybe_outdated",
            "severity": "review",
            "params": {"reasons": ["thesis_changed"]},
        }
    ]
    add_note(pid, vwce, "weakens")
    report = run()
    assert plan_vs_thesis_open(pid, vwce)
    assert report.profiles[0].stats["plan_checked"] == 4  # 3 held + 1 watched
    hints = client.get(f"{base}/watchlist").json()[0]["hints"]
    assert client.get(f"{base}/positions/{vwce}").json()["hints"] == hints
    assert hints[0]["code"] == "recommendation_maybe_outdated"  # P3, the rest is P2
    hints = hints[1:]
    assert codes(hints) == ["plan_vs_thesis", "thesis_weakened"]
    assert hints[0]["params"] == {"plan": "buy_asap", "health": "weakened"}
    # never plan_no_exit for a watched instrument
    with get_session() as s:
        keys = set(s.exec(select(InvSignal.dedup_key).where(InvSignal.profile_id == pid)).all())
    assert f"plan:plan_no_exit|i:{vwce}" not in keys

    # a triggered alert leads (one hint per alert, the title for the app)
    with get_session() as s:
        s.add(
            InvAlert(
                profile_id=pid,
                instrument_id=vwce,
                scope="instrument",
                kind="drawdown_from_high",
                params={"window_days": 252, "threshold": 0.3},
                title="Przykladowy alert",
                status="triggered",
            )
        )
        s.commit()
    hints = client.get(f"{base}/watchlist").json()[0]["hints"][1:]
    assert codes(hints) == ["alert_triggered", "plan_vs_thesis", "thesis_weakened"]
    assert hints[0]["severity"] == "review"
    assert hints[0]["params"]["kind"] == "drawdown_from_high"
    assert hints[0]["params"]["title"] == "Przykladowy alert"

    # the plan changes: resolved at once; un-watching resolves too
    client.put(f"{base}/instruments/{vwce}/plan", json={"plan": "buy"})
    assert plan_vs_thesis_open(pid, vwce)
    item_id = client.get(f"{base}/watchlist").json()[0]["id"]
    assert client.delete(f"{base}/watchlist/{item_id}").status_code == 200
    assert not plan_vs_thesis_open(pid, vwce)
    # neither held nor watched: no hints on the asset detail
    assert client.get(f"{base}/positions/{vwce}").json()["hints"] == []


def test_plan_vs_thesis_follows_research_note_writes(api):
    """Review BE-1: the hint comes from the live health and the signal is synced after a research
    note is stored (MCP), dismissed or restored (API), without a daily run."""
    client, pid, base = api
    abc = instrument_id("ABC")
    client.post(
        f"{base}/instruments/{abc}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza", "exit_plan": "Koniec 2028"},
    )
    client.put(f"{base}/instruments/{abc}/plan", json={"plan": "buy"})

    def abc_codes() -> list[str]:
        rows = client.get(f"{base}/positions").json()["positions"]
        return codes(next(r for r in rows if r["instrument"]["id"] == abc)["hints"])

    assert not plan_vs_thesis_open(pid, abc) and "plan_vs_thesis" not in abc_codes()
    added = CashuMcp(pid, today=AS_OF).call(
        "add_research_note",
        {
            "kind": "news",
            "polarity": "negative",
            "strength": 2,
            "instrument": "ABC",
            "thesis_relation": "invalidates",
            "thesis_field": "invalidation",
            "title": "Przykladowy fakt podwazajacy",
            "summary": "Przykladowy fakt ze zrodlem.",
            "sources": [
                {
                    "url": "https://example.com/news/1",
                    "publisher": "Example News",
                    "published_at": utcnow().date().isoformat(),
                }
            ],
        },
    )
    assert added.ok, added.error
    assert plan_vs_thesis_open(pid, abc)
    assert "plan_vs_thesis" in abc_codes() and "thesis_invalidated" in abc_codes()

    note_id = added.data["note_id"]
    r = client.patch(f"{base}/research/{note_id}", json={"dismissed": True})
    assert r.status_code == 200, r.text
    assert not plan_vs_thesis_open(pid, abc)
    assert not {"plan_vs_thesis", "thesis_invalidated"} & set(abc_codes())

    r = client.patch(f"{base}/research/{note_id}", json={"dismissed": False})
    assert r.status_code == 200, r.text
    assert plan_vs_thesis_open(pid, abc)
    assert "plan_vs_thesis" in abc_codes()


def test_a_held_watchlist_item_gets_the_held_table(api):
    client, _pid, base = api
    run()
    watch(client, base, "XMPL")
    item = client.get(f"{base}/watchlist").json()[0]
    assert item["held"] is True
    assert codes(item["hints"]) == ["gain_review", "concentration", "no_thesis"]


# --------------------------------------------------------------------------- #
# MCP: hints identical in strict and full mode, no alert title
# --------------------------------------------------------------------------- #


def test_mcp_hints_are_the_same_in_strict_and_full(api):
    client, pid, base = api
    vwce = watch(client, base)
    client.put(f"{base}/instruments/{vwce}/plan", json={"plan": "buy"})
    with get_session() as s:
        s.add(
            InvAlert(
                profile_id=pid,
                instrument_id=vwce,
                scope="instrument",
                kind="price_below",
                params={"level": 1234.5},
                title="Ponizej 1234.50 EUR",
                status="triggered",
            )
        )
        s.commit()
    run()

    def hints_in(level: str) -> tuple[list, list]:
        with get_session() as s:
            p = s.get(Profile, pid)
            p.mcp_privacy = level
            s.add(p)
            s.commit()
        mcp = CashuMcp(pid, today=AS_OF)
        positions = mcp.call("positions")
        watchlist = mcp.call("watchlist")
        assert positions.ok and watchlist.ok, (positions.error, watchlist.error)
        return (
            [(r["symbol"], r["hints"]) for r in positions.data["positions"]],
            [i["hints"] for i in watchlist.data["items"]],
        )

    strict, full = hints_in("strict"), hints_in("amounts")
    assert strict == full
    held, watched = strict
    xmpl = dict(held)["XMPL"]
    assert xmpl[0] == {
        "code": "gain_review",
        "severity": "review",
        "params": {"gain": 1.0, "threshold": 0.5, "has_exit_plan": False},
    }
    alert = watched[0][0]
    assert alert["code"] == "alert_triggered" and set(alert["params"]) == {"alert_id", "kind"}
    assert alert["params"]["kind"] == "price_below"
    assert codes(watched[0]) == ["alert_triggered", "plan_without_thesis", "no_thesis"]


# --------------------------------------------------------------------------- #
# Thesis health: research tagged, never dropped (core_changed_at)
# --------------------------------------------------------------------------- #


def thesis_row(thesis_id: int) -> InvThesis:
    with get_session() as s:
        row = s.get(InvThesis, thesis_id)
        s.expunge(row)
        return row


def summary_row(client, base: str, iid: int) -> dict:
    summary = client.get(f"{base}/research/summary").json()
    return next(i for i in summary["instruments"] if i["instrument_id"] == iid)


def test_core_changed_at_moves_only_with_core_fields(api):
    client, _pid, base = api
    abc = instrument_id("ABC")
    created = client.post(
        f"{base}/instruments/{abc}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    ).json()
    row = thesis_row(created["id"])
    assert row.core_changed_at == row.created_at
    assert created["core_changed_at"] == created["created_at"]
    first = row.core_changed_at
    for body in ({"exit_plan": "Nieustalony"}, {"size_plan": "Do 5 %"}, {"exit_plan": None}):
        client.patch(f"{base}/theses/{created['id']}", json=body)
    client.patch(f"{base}/theses/{created['id']}", json={"thesis": "Przykladowa teza"})  # same
    row = thesis_row(created["id"])
    assert row.core_changed_at == first and row.updated_at > first
    client.patch(f"{base}/theses/{created['id']}", json={"invalidation": "Spadek marzy"})
    assert thesis_row(created["id"]).core_changed_at > first


def test_a_thesis_edit_tags_research_and_an_exit_plan_edit_does_not(api):
    client, pid, base = api
    abc = instrument_id("ABC")
    created = client.post(
        f"{base}/instruments/{abc}/theses",
        json={"entry_type": "trend", "thesis": "Przykladowa teza"},
    ).json()
    with get_session() as s:  # the thesis is older than the note
        row = s.get(InvThesis, created["id"])
        older = utcnow() - dt.timedelta(hours=2)
        row.created_at = row.updated_at = row.core_changed_at = older
        s.add(row)
        s.commit()
    note_id = add_note(pid, abc, "weakens", stored_ago=dt.timedelta(minutes=5))
    row = summary_row(client, base, abc)
    assert (row["health"], row["health_predates_thesis"]) == ("weakened", False)

    # clearing a placeholder exit plan keeps the research and does not tag it
    client.patch(f"{base}/theses/{created['id']}", json={"exit_plan": "Brak planu wyjscia"})
    client.patch(f"{base}/theses/{created['id']}", json={"exit_plan": None})
    row = summary_row(client, base, abc)
    assert (row["health"], row["health_predates_thesis"]) == ("weakened", False)
    assert row["counts"]["weakens"] == 1 and row["fields"][0]["weakens"] == 1
    notes = client.get(f"{base}/research", params={"instrument": abc}).json()
    assert [(n["id"], n["predates_thesis"]) for n in notes] == [(note_id, False)]

    # a core edit: the note still counts (health kept) and is tagged
    client.patch(f"{base}/theses/{created['id']}", json={"thesis": "Nowa przykladowa teza"})
    row = summary_row(client, base, abc)
    assert (row["health"], row["health_predates_thesis"]) == ("weakened", True)
    assert row["counts"]["weakens"] == 1 and row["note_ids"] == [note_id]
    assert row["fields"][0]["weakens"] == 1
    notes = client.get(f"{base}/research", params={"instrument": abc}).json()
    assert [(n["id"], n["predates_thesis"]) for n in notes] == [(note_id, True)]
    rows = client.get(f"{base}/positions").json()["positions"]
    hints = next(r for r in rows if r["instrument"]["id"] == abc)["hints"]
    assert hints[0] == {
        "code": "thesis_weakened",
        "severity": "review",
        "params": {"predates_thesis": True},
    }

    # MCP research_notes carries the tag
    mcp = CashuMcp(pid, today=dt.date.today())  # noqa: DTZ011 - notes are stored now
    notes = mcp.call("research_notes")
    assert notes.ok, notes.error
    assert [n["predates_thesis"] for n in notes.data["notes"]] == [True]

    # a new note after the edit wins by the normal precedence and is untagged
    newer = add_note(pid, abc, "invalidates")
    row = summary_row(client, base, abc)
    assert (row["health"], row["health_predates_thesis"]) == ("invalidated", False)
    notes = client.get(f"{base}/research", params={"instrument": abc}).json()
    assert {n["id"]: n["predates_thesis"] for n in notes} == {note_id: True, newer: False}
