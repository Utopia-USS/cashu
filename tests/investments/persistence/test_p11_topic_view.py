"""P11: the market view under a topic thesis (``Ocena teraz`` / ``Perspektywa``): the agent writes it
over MCP (``set_topic_market_view``), the owner edits or clears it over HTTP (``PUT /investments/
topics/{segment}/view``), ``research_context`` and ``GET /research/segments`` carry it, buy / sell and
security price-call wording is refused, it survives a thesis edit, legacy note-level copies stay
stored but hidden, and migrations 0024 / 0025 round-trip. The agent's outlook rests on a sourced
quantitative industry estimate (owner decision 2026-10-10: ``sources`` required, a number other than
a year / horizon required); institutions' forecasts of macro / market trends pass, security, valuation
and index price calls do not. Synthetic data only."""

from __future__ import annotations

import pytest
from mcp_support import TODAY, seed_profile

from cashu.core import db, migrations
from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.modules.investments.models import InvResearchNote
from cashu.modules.investments.research import topic_theses
from cashu.modules.investments.research.validation import (
    has_quantitative_estimate,
    market_view_problem,
)

ASSESSMENT = (
    "Adopcja robotów przemysłowych przyspiesza, ale wyceny sektora jako całości są wysokie."
)
OUTLOOK = (
    "IFR szacuje wzrost instalacji robotów przemysłowych do ok. 575 tys. rocznie w 2028; "
    "ryzykiem jest słabszy cykl inwestycyjny."
)
SOURCES = [
    {
        "title": "World Robotics 2026",
        "url": "https://example.org/p11/world-robotics",
        "publisher": "Example Robotics Federation",
        "published_at": "2026-09-24",
    }
]


@pytest.mark.parametrize(
    "wording",
    [
        "Kup teraz, kurs wzrośnie do 100.",
        "Kurs NVDA wzrośnie w ciągu roku, bo popyt rośnie.",
        "Cel cenowy dla spółki to 200 USD w ciągu roku.",
        "Akcje spółek robotycznych mogą wzrosnąć o połowę.",
        "Notowania producentów odbiją w drugim półroczu.",
        "Cena docelowa ETF-u to 50 zł na koniec roku.",
        "The stock will double within two years of adoption.",
        "Sprzedaj przed wynikami, popyt słabnie w Chinach.",
        "S&P 500 wzrośnie do 7000 punktów w 2027.",
        "Wyceny spółek robotycznych spadną o połowę w 2 lata.",
        "Cena złota wzrośnie do 3000 USD w 2027.",
        "Fed prognozuje, że indeks Nasdaq zyska 20 % w 2027.",
        "The S&P 500 will reach 7000 by 2027.",
    ],
)
def test_price_calls_and_advice_are_refused(wording):
    assert market_view_problem(wording)


@pytest.mark.parametrize(
    "wording",
    [
        "Popyt na chipy do AI w najbliższych 12 miesiącach pozostanie silny.",
        "Ceny robotów spadną dzięki skali produkcji, co przyspieszy adopcję.",
        "Sprzedaż robotów rośnie, klienci kupują więcej systemów do magazynów.",
        "Wyceny sektora są wysokie, a adopcja dopiero przyspiesza.",
        "IEA szacuje, że popyt centrów danych na energię wzrośnie do ok. 945 TWh w 2030.",
        "IFR szacuje, że instalacje robotów wzrosną do 575 tys. rocznie w 2028.",
        "MFW prognozuje wzrost PKB USA o 2,1 % w 2027, co wspiera wydatki na automatyzację.",
        "Installations will reach 575,000 units a year by 2028 (IFR).",
    ],
)
def test_market_and_adoption_wording_passes(wording):
    assert not market_view_problem(wording)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("IFR szacuje 575 tys. instalacji rocznie w 2028.", True),
        ("SIA: sprzedaż chipów +19 % r/r w 2025, WSTS szacuje dalszy wzrost.", True),
        ("Gartner szacuje wydatki na IT na 5,6 bln USD w 2026.", True),
        ("W horyzoncie 2-4 lat oczekuję dalszego wzrostu wdrożeń do 2030 roku.", False),
        ("Popyt w Q3 pozostanie silny przez 12 mies.", False),
        ("Popyt na roboty rośnie, ryzykiem jest cykl.", False),
    ],
)
def test_the_outlook_estimate_check_ignores_years_and_horizons(text, expected):
    assert has_quantitative_estimate(text) is expected


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile()
    return pid, CashuMcp(pid, today=TODAY)


def _note(n: int) -> dict:
    return {
        "kind": "trend",
        "polarity": "positive",
        "strength": 2,
        "segment": "robotics",
        "title": f"Dostawy robotów rosną {n}",
        "summary": "Dostawy robotów przemysłowych wzrosły według danych branżowych.",
        "sources": [
            {
                "url": f"https://example.com/p11/{n}",
                "publisher": "Example News",
                "published_at": TODAY.isoformat(),
            }
        ],
    }


def test_agent_writes_the_view_under_a_thesis_and_the_context_reads_it(host):
    pid, mcp = host
    view = {"segment": "robotics", "assessment": ASSESSMENT, "outlook": OUTLOOK, "sources": SOURCES}
    no_thesis = mcp.call("set_topic_market_view", view)
    assert not no_thesis.ok and "needs a thesis" in no_thesis.error
    assert mcp.call(
        "upsert_topic_thesis", {"segment": "robotics", "thesis": "Robotyka to kolejna fala."}
    ).ok
    written = mcp.call("set_topic_market_view", view)
    assert written.ok, written.error
    assert written.data["thesis_draft"] is True
    # strict privacy mode scrubs amounts in every free text (``575 tys.`` -> ``[amount]``)
    assert written.data["assessment"] == ASSESSMENT
    assert written.data["outlook"].startswith("IFR szacuje wzrost instalacji")
    with get_session() as s:
        assert topic_theses.get(s, pid, "robotics").outlook == OUTLOOK
    assert [x["publisher"] for x in written.data["view_sources"]] == ["Example Robotics Federation"]
    context = mcp.call("research_context", {}).data
    thesis = next(x for x in context["segments"] if x["segment"] == "robotics")["thesis"]
    assert thesis["assessment"] == ASSESSMENT
    assert thesis["outlook"] == written.data["outlook"]
    assert thesis["view_updated_at"]
    assert thesis["view_sources"][0]["url"] == SOURCES[0]["url"]
    assert thesis["view_sources"][0]["published_at"] == "2026-09-24"

    refused = mcp.call("set_topic_market_view", {**view, "outlook": "Kurs akcji wzrośnie o 40%."})
    assert not refused.ok and "outlook" in refused.error
    assert mcp.call("set_topic_market_view", {**view, "segment": "macro_risk"}).ok is False
    with get_session() as s:
        row = topic_theses.get(s, pid, "robotics")
        assert row.outlook == OUTLOOK  # the refused write changed nothing
        assert row.thesis == "Robotyka to kolejna fala." and row.draft


def test_the_agent_view_needs_a_sourced_quantitative_outlook(host):
    pid, mcp = host
    assert mcp.call(
        "upsert_topic_thesis", {"segment": "robotics", "thesis": "Robotyka to kolejna fala."}
    ).ok
    view = {"segment": "robotics", "assessment": ASSESSMENT, "outlook": OUTLOOK}
    missing = mcp.call("set_topic_market_view", view)
    assert not missing.ok and "sources" in missing.error
    for bad, needle in (
        ([], "at least one source"),
        ([{**SOURCES[0], "url": f"https://example.org/p11/{i}"} for i in range(7)], "at most 6"),
        ([{**SOURCES[0], "url": "ftp://example.org/x"}], "http(s)"),
        ([{"url": SOURCES[0]["url"], "published_at": "2026-09-24"}], "publisher"),
        ([{"url": SOURCES[0]["url"], "publisher": "Example"}], "published_at"),
    ):
        refused = mcp.call("set_topic_market_view", {**view, "sources": bad})
        assert not refused.ok and needle in refused.error, (needle, refused.error)
    vague = mcp.call(
        "set_topic_market_view",
        {
            **view,
            "sources": SOURCES,
            "outlook": "W horyzoncie 2-4 lat oczekuję dalszego wzrostu wdrożeń do 2030 roku.",
        },
    )
    assert not vague.ok
    assert vague.error == (
        "outlook needs a sourced quantitative market or demand estimate (who, how much, horizon)"
    )
    with get_session() as s:
        row = topic_theses.get(s, pid, "robotics")
        assert (row.outlook, row.view_sources) == (None, None)  # nothing was written
    trend = mcp.call(
        "set_topic_market_view",
        {
            **view,
            "sources": SOURCES,
            "outlook": "MFW prognozuje wzrost PKB USA o 2,1 % w 2027, a IFR szacuje 575 tys. "
            "instalacji robotów rocznie w 2028.",
        },
    )
    assert trend.ok, trend.error


def test_the_view_survives_thesis_edits_and_leaves_notes_alone(host):
    pid, mcp = host
    added = mcp.call("add_research_note", _note(1))
    assert added.ok, added.error
    with get_session() as s:
        # a legacy note-level copy (briefly allowed before P11) stays stored, never dropped
        row = s.get(InvResearchNote, added.data["note_id"])
        row.details = {"assessment": "stara ocena przy notatce", "outlook": "stara perspektywa"}
        s.add(row)
        topic_theses.save_owner(s, pid, "robotics", "Robotyka to kolejna fala.")
    assert mcp.call(
        "set_topic_market_view",
        {"segment": "robotics", "assessment": ASSESSMENT, "outlook": OUTLOOK, "sources": SOURCES},
    ).ok
    with get_session() as s:
        topic_theses.save_owner(s, pid, "robotics", "Robotyka to kolejna fala automatyzacji.")
        row = topic_theses.get(s, pid, "robotics")
        assert (row.assessment, row.outlook) == (ASSESSMENT, OUTLOOK)
        assert s.get(InvResearchNote, added.data["note_id"]).details["assessment"]
    listed = mcp.call("research_notes", {"segment": "robotics"}).data["notes"]
    assert "assessment" not in (listed[0]["details"] or {})  # hidden from every reader


def test_owner_edits_and_clears_the_view_over_http(api_empty):
    client = api_empty
    pid, slug = seed_profile()
    base = f"/api/p/{slug}/investments/topics/robotics"
    assert client.put(f"{base}/view", json={"assessment": ASSESSMENT}).status_code == 422
    client.put(f"{base}/thesis", json={"thesis": "Robotyka to kolejna fala."})
    put = client.put(f"{base}/view", json={"assessment": ASSESSMENT, "outlook": OUTLOOK})
    assert put.status_code == 200, put.text
    body = put.json()
    assert (body["assessment"], body["outlook"], body["draft"]) == (ASSESSMENT, OUTLOOK, False)
    assert body["view_updated_at"]
    assert client.get(f"{base}/thesis").json()["outlook"] == OUTLOOK
    rows = {
        r["segment"]: r
        for r in client.get(f"/api/p/{slug}/investments/research/segments").json()["segments"]
    }
    assert rows["robotics"]["thesis"]["assessment"] == ASSESSMENT

    assert put.json()["view_sources"] == []
    vague = "Popyt na roboty rośnie, ryzykiem jest słabszy cykl inwestycyjny."
    sourced = client.put(f"{base}/view", json={"outlook": vague, "sources": SOURCES})
    assert sourced.status_code == 200, sourced.text  # the owner's outlook needs no number
    assert sourced.json()["view_sources"][0]["publisher"] == "Example Robotics Federation"
    kept = client.put(f"{base}/view", json={"assessment": ASSESSMENT, "outlook": OUTLOOK}).json()
    assert len(kept["view_sources"]) == 1  # left out: the stored sources stay
    bad_src = client.put(f"{base}/view", json={"outlook": OUTLOOK, "sources": [{"url": "x"}]})
    assert bad_src.status_code == 422
    dropped = client.put(
        f"{base}/view", json={"assessment": ASSESSMENT, "outlook": OUTLOOK, "sources": None}
    ).json()
    assert dropped["view_sources"] == []
    client.put(f"{base}/view", json={"assessment": ASSESSMENT, "sources": SOURCES})
    only = client.put(f"{base}/view", json={"assessment": ASSESSMENT, "outlook": " "}).json()
    assert (only["assessment"], only["outlook"]) == (ASSESSMENT, None)
    assert len(only["view_sources"]) == 1
    bad = client.put(f"{base}/view", json={"assessment": "Cel cenowy 300 USD dla lidera sektora."})
    assert bad.status_code == 422
    assert client.put(f"{base}/view", json={"assessment": "x", "extra": 1}).status_code == 422
    cleared = client.put(f"{base}/view", json={}).json()
    assert (cleared["assessment"], cleared["outlook"], cleared["view_updated_at"]) == (
        None,
        None,
        None,
    )
    assert cleared["view_sources"] == []  # a cleared view keeps no sources
    assert (
        client.put(f"/api/p/{slug}/investments/topics/macro_risk/view", json={}).status_code == 422
    )
    with get_session() as s:
        assert topic_theses.get(s, pid, "robotics").thesis == "Robotyka to kolejna fala."


def test_migration_0024_round_trips_and_refuses_to_drop_a_view(tmp_path):
    from test_be_migration import TS, _db_at, _profile_id, _sql, _to

    path = _db_at(tmp_path, "0023_change_events")
    engine = db.make_engine(f"sqlite:///{path}")

    def columns() -> set[str]:
        return {r[1] for r in _sql(path, "PRAGMA table_info('inv_topic_theses')")}

    assert not ({"assessment", "outlook", "view_updated_at"} & columns())
    assert migrations.upgrade_to_head(engine) == "0026_thesis_exit_plan_changed_at"
    assert {"assessment", "outlook", "view_updated_at", "view_sources"} <= columns()
    _sql(
        path,
        "INSERT INTO inv_topic_theses (profile_id, segment, thesis, draft, created_by, "
        "core_changed_at, created_at, updated_at, outlook) VALUES (?, 'robotics', 't', 0, "
        "'owner', ?, ?, ?, 'perspektywa')",
        _profile_id(path),
        TS,
        TS,
        TS,
    )
    with pytest.raises(RuntimeError, match="topic market views exist"):
        _to(engine, "0023_change_events", down=True)
    assert "outlook" in columns()
    _sql(path, "UPDATE inv_topic_theses SET outlook = NULL")
    _to(engine, "0023_change_events", down=True)
    assert not ({"assessment", "outlook", "view_updated_at"} & columns())
    assert migrations.current_revision(engine) == "0023_change_events"
    assert len(_sql(path, "SELECT id FROM inv_topic_theses")) == 1  # the thesis itself stays
    _to(engine, "head")
    assert {"assessment", "outlook", "view_updated_at"} <= columns()


def test_migration_0025_round_trips_and_refuses_to_drop_view_sources(tmp_path):
    from test_be_migration import TS, _db_at, _profile_id, _sql, _to

    path = _db_at(tmp_path, "0024_topic_market_view")
    engine = db.make_engine(f"sqlite:///{path}")

    def columns() -> set[str]:
        return {r[1] for r in _sql(path, "PRAGMA table_info('inv_topic_theses')")}

    assert "view_sources" not in columns() and "outlook" in columns()
    assert migrations.upgrade_to_head(engine) == "0026_thesis_exit_plan_changed_at"
    assert "view_sources" in columns()
    _sql(
        path,
        "INSERT INTO inv_topic_theses (profile_id, segment, thesis, draft, created_by, "
        "core_changed_at, created_at, updated_at, view_sources) VALUES (?, 'robotics', 't', 0, "
        "'owner', ?, ?, ?, ?)",
        _profile_id(path),
        TS,
        TS,
        TS,
        '[{"url": "https://example.org/x", "publisher": "Example", "published_at": "2026-09-24"}]',
    )
    with pytest.raises(RuntimeError, match="topic view sources exist"):
        _to(engine, "0024_topic_market_view", down=True)
    assert "view_sources" in columns()
    _sql(path, "UPDATE inv_topic_theses SET view_sources = NULL")
    _to(engine, "0024_topic_market_view", down=True)
    assert "view_sources" not in columns() and "outlook" in columns()
    assert migrations.current_revision(engine) == "0024_topic_market_view"
    assert len(_sql(path, "SELECT id FROM inv_topic_theses")) == 1  # the thesis itself stays
    _to(engine, "head")
    assert "view_sources" in columns()
