"""Research MCP tools (F6) on the synthetic sensitive profile: the run / note round trip, fixable errors
(schema, cooldown, owner-named instruments), audit without values, strict-mode scrubbing of note text and
strategy sections (amounts in amounts mode, identifiers never), the extended context (buckets, sections,
entry types, exposure), and profile binding."""

from __future__ import annotations

import json

import pytest
from mcp_support import CLAIM_SYMBOL, PERSON_P2P, TODAY, seed_profile, write_strategy
from sqlmodel import select

from cashu.core.agent_models import McpCall
from cashu.core.db import get_session
from cashu.core.mcp.server import CashuMcp
from cashu.core.models import Profile
from cashu.modules.investments.models import InvResearchNote, InvSignal
from cashu.modules.investments.service import files

IBAN = "PL61109010140000071219812874"
STRATEGY_MD = f"""# Strategia

## Cel

Emerytura, wplacam 4321.09 PLN miesiecznie.

## W co wierzę

Rynki rosna w dlugim terminie; {PERSON_P2P} doradzila mi ETF-y.

## Zasady wejścia i wyjścia

- Kupuje przy korekcie sentymentu o 20%.
- Pozycja najwyzej 12345.67 PLN.

## Czego unikam

- Kryptowalut i dzwigni; konto {IBAN}.
"""


def source(n: int) -> list[dict]:
    return [
        {
            "url": f"https://example.com/news/{n}",
            "publisher": "Example News",
            "published_at": TODAY.isoformat(),
        }
    ]


def note(n: int = 1, **extra) -> dict:
    return {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "instrument": "PKO",
        "title": f"Marza banku spada {n}",
        "summary": f"Raport: zysk 4321.09 PLN, konto {IBAN}, rozmowa z {PERSON_P2P}.",
        "sources": source(n),
        **extra,
    }


@pytest.fixture
def host(db_engine):
    pid, slug = seed_profile()
    files.write_text_private(files.strategy_md_path(slug), STRATEGY_MD)
    return pid, slug, CashuMcp(pid, today=TODAY)


def _privacy(pid: int, level: str) -> None:
    with get_session() as s:
        p = s.get(Profile, pid)
        p.mcp_privacy = level
        s.add(p)


def test_run_and_note_round_trip_with_a_signal(host):
    _pid, _slug, mcp = host
    assert mcp.call(
        "upsert_thesis", {"instrument": "PKO", "entry_type": "trend", "thesis": "Bank rosnie"}
    ).ok
    run = mcp.call("start_research_run", {"scope": {"scheduled": True, "themes": ["Banki"]}})
    assert run.ok, run.error
    run_id = run.data["run_id"]
    assert run.data["scope"]["covered_instruments"] >= 2  # held, no claim / cash
    busy = mcp.call("start_research_run", {})
    assert not busy.ok and busy.error_kind == "conflict"
    added = mcp.call(
        "add_research_note",
        note(thesis_relation="invalidates", thesis_field="invalidation", run_id=run_id),
    )
    assert added.ok, added.error
    assert added.data["signal"]["created"] is True
    community = mcp.call(
        "add_research_note",
        {
            "kind": "community",
            "polarity": "positive",
            "strength": 3,
            "theme": "Banki",
            "title": "Forum o bankach",
            "summary": "Duzo wpisow o bankach po decyzji RPP.",
            "sources": source(2),
            "details": {"scale": "medium"},
            "expires_in_days": 15,
        },
    )
    assert community.ok, community.error
    finished = mcp.call("finish_research_run", {"run_id": run_id, "counts": {"sources_checked": 9}})
    assert finished.ok, finished.error
    counts = finished.data["counts"]
    assert counts["notes"] == 2 and counts["by_kind"]["community"] == 1
    assert counts["sources_checked"] == 9 and counts["signals"] == 2
    with get_session() as s:
        sig = s.exec(select(InvSignal).where(InvSignal.dedup_key.startswith("research:"))).all()
        assert sorted(x.severity for x in sig) == ["action", "info"]
        audit = s.exec(select(McpCall).where(McpCall.tool == "add_research_note")).all()
        assert all(PERSON_P2P not in json.dumps(a.args) for a in audit)
        assert audit[0].args["sources"] == "array"
    listed = mcp.call("research_notes", {}).data["notes"]
    assert {n["kind"] for n in listed} == {"news", "community"}
    context = mcp.call("research_context", {}).data
    pko = next(p for p in context["positions"] if p["symbol"] == "PKO")
    assert pko["research"]["health"] == "invalidated" and pko["entry_type"] == "trend"
    assert context["last_done_run"]["run_id"] == run_id
    assert context["themes"][0]["theme"] == "Banki"


def test_fixable_errors(host):
    _pid, _slug, mcp = host
    no_source = mcp.call("add_research_note", note(sources=[]))
    assert not no_source.ok and no_source.error_kind == "invalid" and "sources" in no_source.error
    bypass = mcp.call(
        "add_research_note",
        note(sources=[{**source(1)[0], "url": "https://archive.ph/x"}]),
    )
    assert not bypass.ok and "paywall" in bypass.error
    target = mcp.call("add_research_note", note(title="Cena docelowa 60 zl"))
    assert not target.ok and "recommendation" in target.error
    amounts = mcp.call("add_research_note", note(details={"price_target": 60}))
    assert not amounts.ok and "no amounts" in amounts.error
    no_thesis = mcp.call("add_research_note", note(thesis_relation="weakens"))
    assert not no_thesis.ok and "no thesis" in no_thesis.error
    unknown = mcp.call("add_research_note", note(instrument="NOPE"))
    assert not unknown.ok and unknown.error_kind == "not_found"
    claim = mcp.call("add_research_note", note(instrument=CLAIM_SYMBOL))
    assert not claim.ok
    assert mcp.call("finish_research_run", {"run_id": 999}).error_kind == "not_found"
    bad_scope = mcp.call("start_research_run", {"scope": {"everything": True}})
    assert not bad_scope.ok and bad_scope.error_kind == "invalid"
    extra = mcp.call("add_research_note", {**note(), "profile": "other"})
    assert not extra.ok and extra.error_kind == "invalid_arguments"


def test_candidate_cooldown_is_a_conflict(host):
    pid, _slug, mcp = host
    candidate = {
        "kind": "candidate",
        "polarity": "positive",
        "strength": 2,
        "title": "Newco spelnia kryteria",
        "summary": "Spolka spelnia dwa z trzech kryteriow strategii.",
        "sources": source(5),
        "candidate": {"symbol_or_isin": "NEWCO.WA", "name": "Newco SA"},
        "details": {
            "entry_type": "trend",
            "criteria": [{"text": "trend 200 sesji", "met": True, "threshold": "powyzej SMA"}],
        },
    }
    first = mcp.call("add_research_note", candidate)
    assert first.ok, first.error
    assert first.data["signal"] is None  # candidates never become signals
    with get_session() as s:
        from cashu.modules.investments.research import service

        service.dismiss(s, s.get(Profile, pid), first.data["note_id"])
    again = mcp.call("add_research_note", {**candidate, "sources": source(6), "title": "Newco 2"})
    assert not again.ok and again.error_kind == "conflict" and "before" in again.error
    context = mcp.call("research_context", {}).data
    assert context["candidates"]["dismissed_cooldown"][0]["candidate"] == "NEWCO.WA"
    notes = mcp.call("research_notes", {"kind": "candidate"}).data["notes"]
    assert notes[0]["dismissed"] is True and notes[0]["candidate"]["cooldown_until"]


def test_strict_mode_scrubs_note_text_and_strategy_sections(host):
    pid, _slug, mcp = host
    assert mcp.call("add_research_note", note()).ok
    strict = json.dumps(
        [mcp.call("research_notes", {}).data, mcp.call("research_context", {}).data],
        ensure_ascii=False,
    )
    for secret in (IBAN, "WISNIEWSKA", "4321.09", "4321,09", "12345.67"):
        assert secret not in strict, secret
    assert "[amount]" in strict
    context = mcp.call("research_context", {}).data
    sections = {x["section"]: x for x in context["strategy"]["sections"]}
    assert set(sections) == {"beliefs", "entry_exit", "avoid"}
    assert "Kryptowalut" in sections["avoid"]["text"] and "20%" in sections["entry_exit"]["text"]
    assert "Emerytura" not in strict  # "Cel" is not a research section
    _privacy(pid, "amounts")
    loose = json.dumps(
        [mcp.call("research_notes", {}).data, mcp.call("research_context", {}).data],
        ensure_ascii=False,
    )
    assert "4321.09" in loose and "12345.67" in loose
    assert IBAN not in loose and "WISNIEWSKA" not in loose


def test_context_carries_buckets_entry_types_and_exposure(host):
    _pid, slug, mcp = host
    write_strategy(slug)  # the synthetic strategy (buckets stocks / cash)
    files.write_text_private(files.strategy_md_path(slug), STRATEGY_MD)
    mcp.call("upsert_thesis", {"instrument": "PKO", "entry_type": "trend", "thesis": "x"})
    context = mcp.call("research_context", {}).data
    strategy = context["strategy"]
    assert [b["bucket"] for b in strategy["buckets"]] == ["stocks", "cash"]
    assert strategy["buckets"][0]["asset_classes"] == ["equity", "etf"]
    assert strategy["buckets"][0]["target"] == 0.8
    assert strategy["entry_types"] == ["sentiment_correction", "trend", "special_situation"]
    assert strategy["entry_types_in_use"] == [{"entry_type": "trend", "theses": 1}]
    assert {e["asset_class"] for e in context["exposure"]["asset_classes"]} >= {"equity"}
    assert all(p["symbol"] != CLAIM_SYMBOL for p in context["positions"])
    assert "claim" not in {p["asset_class"] for p in context["positions"]}
    assert len(context["week_starts"]) == 8


def test_tools_are_bound_to_their_profile(host):
    pid, _slug, mcp = host
    mcp.call("add_to_watchlist", {"symbol_or_isin": "CDR.WA"})
    run_id = mcp.call("start_research_run", {}).data["run_id"]
    note_id = mcp.call("add_research_note", note()).data["note_id"]
    other, _ = seed_profile("Ewa Testowa", run_daily=False)
    stranger = CashuMcp(other, today=TODAY)
    assert stranger.call("research_notes", {}).data["notes"] == []
    assert stranger.call("research_context", {}).data["last_run"] is None
    assert stranger.call("finish_research_run", {"run_id": run_id}).error_kind == "not_found"
    watched_only = stranger.call("add_research_note", note(instrument="CDR"))
    assert watched_only.error_kind == "not_found"
    ok = stranger.call("add_research_note", note())  # its own PKO holding
    assert ok.ok and ok.data["run_id"] is None  # A's running run is not B's
    with get_session() as s:
        assert s.get(InvResearchNote, note_id).profile_id == pid
        assert s.get(InvResearchNote, ok.data["note_id"]).profile_id == other


def test_research_signal_message_is_polish_and_scrubbed_in_strict_mode(host):
    pid, _slug, mcp = host
    # (an amount within 24 characters before "siła N" would also scrub N: the redactor's money-word rule
    # matches its own "[amount]" placeholder, for English and Polish text alike)
    title = "Odpis 4321,09 PLN obniża zysk banku"
    assert mcp.call("add_research_note", note(strength=3, title=title)).ok
    with get_session() as s:
        (sig,) = s.exec(select(InvSignal).where(InvSignal.dedup_key.startswith("research:"))).all()
    assert sig.message == f"Analiza (wiadomość): {title}; siła 3/3, 1 źródło"

    def listed() -> str:
        signals = mcp.call("signals", {}).data["signals"]
        (row,) = [x for x in signals if x["kind"] == "research:news"]
        return row["message"]

    assert listed() == "Analiza (wiadomość): Odpis [amount] obniża zysk banku; siła 3/3, 1 źródło"
    _privacy(pid, "amounts")
    assert listed() == sig.message
