"""P9 against a real DB and the API: macro cards' ``brief`` / ``plain``, topic rows' ``briefs`` / ``thesis``
(``GET /research/segments``), topic theses over HTTP (``GET|PUT|DELETE /investments/topics/{segment}/
thesis``), a topic note's thesis relation (needs the topic thesis; invalidates -> action signal), the
near-duplicate guard and the ``full_refresh`` run. Synthetic data only."""

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
)
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.macro import service as macro_service
from cashu.modules.investments.macro import texts
from cashu.modules.investments.models import InvSignal, InvTopicThesis
from cashu.modules.investments.research import service, topic_theses, views
from cashu.modules.investments.research.validation import RunScope, validate_note
from cashu.modules.investments.service import files

TOPIC_BRIEF = {
    "headline": "Rośnie popyt na chipy do centrów danych",
    "why": "Najwięksi klienci zwiększyli wydatki na serwery z AI.",
}
MACRO_BRIEF = {
    "headline": "Trwa hossa na giełdach",
    "why": "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
    "supports": ["Banki centralne obniżają stopy"],
    "risks": ["Wyceny są wysoko"],
}


def setup_investor(name: str = "Briefy") -> tuple[int, str]:
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
    macro_service.clear_cache()
    pid, slug = setup_investor()
    return api_empty, pid, f"/api/p/{slug}/investments"


def raw(n: int, **changes) -> dict:
    data = {
        "kind": "trend",
        "polarity": "positive",
        "strength": 2,
        "title": f"Przykładowy fakt numer {n} " + distinct_words(n),
        "summary": f"Przykładowy fakt {distinct_words(n)} ze źródła, opisany neutralnie.",
        "sources": [
            {
                "url": f"https://example.com/p9/{n}",
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
    instrument: str | None = None,
    run_id=None,
    ago: int = 0,
    **changes,
) -> int:
    """Store a note as the agent; ``ago`` > 0 stores it that many days back (observed and stored
    then), as an earlier weekly run would have."""
    at = utcnow() - dt.timedelta(days=ago)
    if ago:
        changes.setdefault("observed_at", at.date().isoformat())
    with get_session() as s:
        note = raw(n, **changes)
        note["sources"][0]["published_at"] = at.date().isoformat()
        data = validate_note(note, now=at)
        ref = service.resolve_reference(s, pid, instrument) if instrument else None
        return service.add_note(
            s, s.get(Profile, pid), data, instrument_id=ref, run_id=run_id, now=at
        ).note.id


def brief_note(pid: int, n: int, segment: str, brief: dict, **changes) -> int:
    changes.setdefault("expires_in_days", 60)
    return add(pid, n, segment=segment, details={"brief": brief}, **changes)


def call(pid: int, fn, *args, **kwargs):
    with get_session() as s:
        return fn(s, s.get(Profile, pid), *args, **kwargs)


# --------------------------------------------------------------------------- #
# API: macro brief / plain, topic briefs / thesis
# --------------------------------------------------------------------------- #


def test_macro_cards_carry_plain_and_the_latest_brief(api):
    client, pid, base = api
    cards = {c["key"]: c for c in client.get(f"{base}/research/macro").json()["regimes"]}
    assert all(c["brief"] is None for c in cards.values())
    assert cards["risk"]["plain"] == texts.PLAIN_UNKNOWN  # no macro data in this DB
    brief_note(pid, 1, "macro_risk", MACRO_BRIEF, kind="macro", ago=9)
    newer = {**MACRO_BRIEF, "headline": "Hossa trwa mimo słabszych danych"}
    newest = brief_note(pid, 2, "macro_risk", newer, kind="macro")
    add(pid, 3, segment="macro_dollar", kind="macro")  # a note without a brief
    cards = {c["key"]: c for c in client.get(f"{base}/research/macro").json()["regimes"]}
    got = cards["risk"]["brief"]
    assert set(got) == {
        "note_id",
        "headline",
        "why",
        "supports",
        "risks",
        "observed_at",
        "unread",
    }
    assert (got["note_id"], got["headline"], got["unread"]) == (newest, newer["headline"], True)
    assert (got["supports"], got["risks"]) == (MACRO_BRIEF["supports"], MACRO_BRIEF["risks"])
    assert cards["dollar"]["brief"] is None and cards["dollar"]["note"] is not None


def test_topic_rows_carry_up_to_three_active_briefs_newest_first(api):
    client, pid, base = api
    ids = []
    for n, ago in enumerate((30, 23, 16, 9), start=1):
        headline = (
            "Rośnie popyt na chipy",
            "Producenci chipów budują fabryki",
            "Ceny pamięci w górę",
            "Rynek w konsolidacji",
        )[n - 1]
        ids.append(
            brief_note(
                pid,
                n,
                "semis_ai",
                {"headline": headline, "why": f"Inny powód {distinct_words(n)}."},
                ago=ago,
            )
        )
    add(pid, 9, segment="semis_ai")  # newest, but no brief
    expired = brief_note(pid, 10, "games_media", TOPIC_BRIEF, ago=20, expires_in_days=19)
    rows = {r["segment"]: r for r in client.get(f"{base}/research/segments").json()["segments"]}
    briefs = rows["semis_ai"]["briefs"]
    assert [b["note_id"] for b in briefs] == ids[::-1][:3]
    assert set(briefs[0]) == {
        "note_id",
        "headline",
        "why",
        "observed_at",
        "kind",
        "polarity",
        "unread",
    }
    assert (briefs[0]["kind"], briefs[0]["polarity"], briefs[0]["unread"]) == (
        "trend",
        "positive",
        True,
    )
    assert rows["semis_ai"]["thesis"] is None
    assert expired and rows.get("games_media", {"briefs": []})["briefs"] == []  # expired


def test_topic_thesis_http_crud(api):
    client, _pid, base = api
    url = f"{base}/topics/games_media/thesis"
    assert client.get(url).status_code == 200 and client.get(url).json() is None
    put = client.put(url, json={"thesis": "Ludzie grają coraz więcej.", "invalidation": "Spadek"})
    assert put.status_code == 200
    body = put.json()
    assert set(body) == {
        "id",
        "segment",
        "label",
        "thesis",
        "invalidation",
        "assessment",
        "outlook",
        "view_updated_at",
        "view_sources",
        "draft",
        "created_by",
        "core_changed_at",
        "created_at",
        "updated_at",
    }
    assert (body["segment"], body["label"], body["draft"], body["created_by"]) == (
        "games_media",
        "Gry",
        False,
        "owner",
    )
    assert body["assessment"] is None and body["outlook"] is None
    assert client.get(url).json() == body
    # the topic shows as a row with its thesis (a thesis alone makes the row)
    rows = {r["segment"]: r for r in client.get(f"{base}/research/segments").json()["segments"]}
    assert rows["games_media"]["thesis"]["thesis"] == "Ludzie grają coraz więcej."
    cleared = client.put(url, json={"thesis": "Ludzie grają coraz więcej."}).json()
    assert cleared["invalidation"] is None and cleared["id"] == body["id"]
    assert client.put(url, json={"thesis": " "}).status_code == 422
    assert client.put(url, json={"thesis": "x" * 601}).status_code == 422
    assert client.put(url, json={"thesis": "ok", "target": 1}).status_code == 422
    assert client.get(f"{base}/topics/macro_risk/thesis").status_code == 422
    assert client.put(f"{base}/topics/Gry/thesis", json={"thesis": "x"}).status_code == 422
    assert client.delete(url).json() == {"deleted": True}
    assert client.delete(url).json() == {"deleted": False}
    assert client.get(url).json() is None


def test_owner_save_confirms_an_agent_draft(api):
    client, pid, base = api
    with get_session() as s:
        row, created = topic_theses.upsert_draft(s, pid, "semis_ai", "Szkic tezy o chipach.")
        assert created and row.draft and row.created_by == "agent"
        again, created = topic_theses.upsert_draft(
            s, pid, "semis_ai", "Szkic tezy o chipach v2.", "Spadek popytu"
        )
        assert not created and again.id == row.id and again.draft
        kept, _ = topic_theses.upsert_draft(s, pid, "semis_ai", "Szkic tezy o chipach v3.")
        assert kept.invalidation == "Spadek popytu"  # an omitted invalidation keeps the draft's
    url = f"{base}/topics/semis_ai/thesis"
    assert client.get(url).json()["draft"] is True
    confirmed = client.put(url, json={"thesis": "Szkic tezy o chipach v3.", "invalidation": "X"})
    assert (confirmed.json()["draft"], confirmed.json()["created_by"]) == (False, "agent")
    with get_session() as s, pytest.raises(topic_theses.OwnerThesis, match="never overwrite"):
        topic_theses.upsert_draft(s, pid, "semis_ai", "Nowa teza agenta.")


def test_topic_theses_are_per_profile(api):
    client, _pid, base = api
    other, _slug = make_profile("Inny")
    with get_session() as s:
        topic_theses.save_owner(s, other, "crypto", "Teza innego profilu.")
    assert client.get(f"{base}/topics/crypto/thesis").json() is None
    with get_session() as s:
        assert len(s.exec(select(InvTopicThesis)).all()) == 1


# --------------------------------------------------------------------------- #
# Thesis relation on topic notes
# --------------------------------------------------------------------------- #


def test_a_topic_note_bears_on_the_topic_thesis_only_when_it_exists(investor):
    pid, _ = investor
    with pytest.raises(service.ResearchError, match="that topic has no thesis"):
        add(pid, 1, segment="healthcare", thesis_relation="weakens")
    with get_session() as s:
        topic_theses.save_owner(s, pid, "healthcare", "Ubezpieczyciele zdrowotni zarabiają.")
    note_id = add(
        pid,
        2,
        segment="healthcare",
        kind="news",
        polarity="negative",
        thesis_relation="invalidates",
        title="Zabójstwo prezesa UnitedHealth wstrząsa branżą",
    )
    with get_session() as s:
        (sig,) = s.exec(
            select(InvSignal).where(
                InvSignal.profile_id == pid, InvSignal.dedup_key.startswith("research:")
            )
        ).all()
        assert sig.severity == "action"
        assert "podważa tezę" in sig.message
        rows = views.notes_view(s, s.get(Profile, pid), service.notes(s, pid, segment="healthcare"))
    assert [(r["id"], r["thesis_relation"], r["thesis_field"]) for r in rows] == [
        (note_id, "invalidates", "thesis")
    ]


# --------------------------------------------------------------------------- #
# Near duplicates
# --------------------------------------------------------------------------- #


def test_near_duplicates_are_refused_within_the_same_scope(investor):
    pid, _ = investor
    first = add(
        pid,
        1,
        instrument="ABC",
        kind="news",
        title="Nvidia podnosi prognozę przychodów na kwartał",
        ago=20,
    )
    with pytest.raises(service.ResearchConflict, match=f"near duplicate of note {first}: Nvidia"):
        add(pid, 2, instrument="ABC", kind="news", title="Nvidia podniosła prognozę przychodów")
    # another fact about the same company passes; the same fact on another scope passes
    add(pid, 3, instrument="ABC", kind="news", title="Nvidia ogłasza skup akcji")
    add(pid, 4, instrument="XMPL", kind="news", title="Nvidia podniosła prognozę przychodów")
    # a brief headline restated on a topic, next week
    brief_note(pid, 5, "semis_ai", TOPIC_BRIEF, ago=8)
    rephrased = {**TOPIC_BRIEF, "headline": "Popyt na chipy do centrów danych dalej rośnie"}
    with pytest.raises(service.ResearchConflict, match="near duplicate"):
        brief_note(pid, 6, "semis_ai", rephrased, title=TOPIC_BRIEF["headline"])


def test_dismissed_and_old_notes_are_not_compared(investor):
    pid, _ = investor
    add(
        pid,
        1,
        instrument="ABC",
        title="CD Projekt przesuwa premierę gry",
        ago=61,
        expires_in_days=90,
    )
    add(pid, 2, instrument="ABC", title="CD Projekt przesunął premierę gry")  # older than 60 days
    dismissed = add(pid, 3, instrument="WRLD", title="Fundusz obniża opłatę za zarządzanie")
    call(pid, service.dismiss, dismissed)
    add(pid, 4, instrument="WRLD", title="Fundusz obniżył opłatę za zarządzanie")


# --------------------------------------------------------------------------- #
# full_refresh
# --------------------------------------------------------------------------- #


def test_a_full_refresh_run_skips_the_novelty_caps_only(investor):
    pid, _ = investor
    run = call(pid, service.start_run, RunScope(full_refresh=True))
    assert service.is_weekly(run) and service.is_full_refresh(run)
    with get_session() as s:
        stored = views.run_dict(s, service.run(s, pid, run.id))
    assert stored["full_refresh"] is True and stored["scope"]["full_refresh"] is True
    for n, ref in enumerate(["ABC", "WRLD", "XMPL"], start=1):
        for k in range(3):  # 3 notes per instrument: over the weekly 2
            add(pid, n * 10 + k, instrument=ref, run_id=run.id)
    segments = ("gold", "crypto", "bonds", "energy", "metals", "power", "healthcare")
    for n, segment in enumerate(segments, start=50):  # 7 segment notes: over the weekly 6
        add(pid, n, segment=segment, kind="macro", run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="already has a note this week"):
        add(pid, 70, segment="gold", kind="macro", run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="near duplicate"):
        add(pid, 71, instrument="ABC", run_id=run.id, title=raw(10)["title"] + " ponownie")
    call(pid, service.finish_run, run.id)
    weekly = call(pid, service.start_run, RunScope(scheduled=True))
    assert not service.is_full_refresh(weekly)
    with get_session() as s:
        assert views.run_dict(s, service.run(s, pid, weekly.id))["full_refresh"] is False


# --------------------------------------------------------------------------- #
# Review fix pass
# --------------------------------------------------------------------------- #


def test_brief_notes_have_their_own_weekly_rule(investor):
    """HIGH-1: a plain topic note this week does not block a brief note (and back); a second brief
    note in the same week is refused, except in a full refresh."""
    pid, _ = investor
    plain_note = add(pid, 1, segment="semis_ai")
    brief_id = brief_note(pid, 2, "semis_ai", TOPIC_BRIEF)
    with pytest.raises(
        service.ResearchConflict, match=f"brief note this week \\(note {brief_id}\\)"
    ):
        brief_note(
            pid,
            3,
            "semis_ai",
            {"headline": "Producenci chipów budują fabryki", "why": "Nowe fabryki w Azji i USA."},
        )
    with pytest.raises(service.ResearchConflict, match=f"note this week \\(note {plain_note}\\)"):
        add(pid, 4, segment="semis_ai")
    # dismissing the plain note does not free the plain slot; it never blocked the brief anyway
    call(pid, service.dismiss, plain_note)
    with pytest.raises(service.ResearchConflict, match="already has a note this week"):
        add(pid, 5, segment="semis_ai")


def test_a_full_refresh_lifts_the_weekly_rule_for_brief_notes_only(investor):
    pid, _ = investor
    brief_note(pid, 1, "macro_risk", MACRO_BRIEF, kind="macro")
    add(pid, 2, segment="macro_risk", kind="macro")
    run = call(pid, service.start_run, RunScope(full_refresh=True))
    changed = {
        **MACRO_BRIEF,
        "headline": "Akcje są w korekcie, ale zyski spółek rosną",
        "why": "Ceny akcji cofnęły się od szczytu, choć wyniki firm są nadal dobre.",
    }
    brief_note(pid, 3, "macro_risk", changed, kind="macro", polarity="neutral", run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="already has a note this week"):
        add(pid, 4, segment="macro_risk", kind="macro", run_id=run.id)


def test_a_brief_with_changed_drivers_replaces_the_shown_one(api):
    """MED-4: same state headline, new why: stored, and it becomes the card's brief; the older one
    stays (never dismissed)."""
    client, pid, base = api
    old = brief_note(pid, 1, "macro_risk", MACRO_BRIEF, kind="macro", ago=10)
    new_brief = {
        **MACRO_BRIEF,
        "headline": "Hossa na giełdach trwa",
        "why": "Banki centralne obniżają koszt kredytu, a rynek pracy pozostaje mocny.",
    }
    new = brief_note(pid, 2, "macro_risk", new_brief, kind="macro")
    cards = {c["key"]: c for c in client.get(f"{base}/research/macro").json()["regimes"]}
    assert cards["risk"]["brief"]["note_id"] == new
    with get_session() as s:
        rows = service.notes(s, pid, segment="macro_risk")
    assert {r.id for r in rows} == {old, new}


def test_a_macro_brief_older_than_the_current_state_is_not_shown():
    """MED-5: the card falls back to ``plain``; an open-ended state keeps the brief."""
    from types import SimpleNamespace

    since = dt.date(2026, 9, 1)
    before = SimpleNamespace(observed_at=dt.datetime(2026, 8, 20, tzinfo=dt.UTC))
    after = SimpleNamespace(observed_at=dt.datetime(2026, 9, 2, tzinfo=dt.UTC))
    regime = SimpleNamespace(since=since)
    assert macro_service._current_brief(SimpleNamespace(briefs=[before]), regime) is None
    assert macro_service._current_brief(SimpleNamespace(briefs=[after]), regime) is after
    open_ended = SimpleNamespace(since=None)
    assert macro_service._current_brief(SimpleNamespace(briefs=[before]), open_ended) is before
    assert macro_service._current_brief(None, regime) is None


def test_no_thesis_relation_against_a_draft(investor):
    """MED-6: the agent's own unconfirmed draft is no thesis to judge against."""
    pid, _ = investor
    with get_session() as s:
        topic_theses.upsert_draft(s, pid, "healthcare", "Szkic tezy o ubezpieczycielach.")
    with pytest.raises(service.ResearchError, match="still a draft"):
        add(pid, 1, segment="healthcare", thesis_relation="weakens")
    with get_session() as s:
        topic_theses.save_owner(s, pid, "healthcare", "Szkic tezy o ubezpieczycielach.")
    add(pid, 2, segment="healthcare", thesis_relation="weakens")


def test_deleting_a_draft_is_a_rejection_with_a_cooldown(api):
    """MED-7: the row stays as a rejection (reads as no thesis), the agent is refused for 90 days,
    the owner may still write his own thesis."""
    client, pid, base = api
    url = f"{base}/topics/crypto/thesis"
    with get_session() as s:
        topic_theses.upsert_draft(s, pid, "crypto", "Szkic tezy o krypto.")
    assert client.delete(url).json() == {"deleted": True}
    assert client.get(url).json() is None
    assert client.delete(url).json() == {"deleted": False}
    rows = {r["segment"]: r for r in client.get(f"{base}/research/segments").json()["segments"]}
    assert rows.get("crypto", {"thesis": None})["thesis"] is None
    with get_session() as s:
        (row,) = s.exec(select(InvTopicThesis).where(InvTopicThesis.segment == "crypto")).all()
        assert row.rejected_at is not None
        assert set(topic_theses.cooldowns(s, pid)) == {"crypto"}
        with pytest.raises(topic_theses.RejectedDraft, match="deleted the thesis on crypto"):
            topic_theses.upsert_draft(s, pid, "crypto", "Nowy szkic o krypto.")
        # after the cooldown the agent may propose again
        row.rejected_at = utcnow() - dt.timedelta(days=91)
        s.add(row)
    with get_session() as s:
        again, created = topic_theses.upsert_draft(s, pid, "crypto", "Nowy szkic o krypto.")
        assert created and again.draft and again.rejected_at is None
        again.rejected_at = utcnow()  # rejected once more
        s.add(again)
    body = client.put(url, json={"thesis": "Moja teza o krypto."}).json()
    assert (body["draft"], body["created_by"], body["thesis"]) == (
        False,
        "owner",
        "Moja teza o krypto.",
    )
    # the owner deleting his own thesis is a rejection too: the same 90-day cooldown
    assert client.delete(url).json() == {"deleted": True}
    assert client.get(url).json() is None
    with get_session() as s:
        assert set(topic_theses.cooldowns(s, pid)) == {"crypto"}
        with pytest.raises(topic_theses.RejectedDraft, match="deleted the thesis on crypto"):
            topic_theses.upsert_draft(s, pid, "crypto", "Kolejny szkic o krypto.")


def test_deleting_a_confirmed_draft_starts_the_cooldown(api):
    client, pid, base = api
    url = f"{base}/topics/gold/thesis"
    with get_session() as s:
        topic_theses.upsert_draft(s, pid, "gold", "Szkic o złocie.")
    assert client.put(url, json={"thesis": "Szkic o złocie."}).json()["draft"] is False
    assert client.delete(url).json() == {"deleted": True}
    with get_session() as s:
        assert set(topic_theses.cooldowns(s, pid)) == {"gold"}
        with pytest.raises(topic_theses.RejectedDraft):
            topic_theses.upsert_draft(s, pid, "gold", "Nowy szkic o złocie.")


def test_a_topic_invalidates_note_passes_the_weekly_segment_cap(investor):
    pid, _ = investor
    with get_session() as s:
        topic_theses.save_owner(s, pid, "healthcare", "Ubezpieczyciele zdrowotni zarabiają.")
    run = call(pid, service.start_run, RunScope(scheduled=True))
    for n, segment in enumerate(("gold", "crypto", "bonds", "energy", "metals", "power"), start=1):
        add(pid, n, segment=segment, kind="macro", run_id=run.id)
    with pytest.raises(service.ResearchConflict, match="already has 6 segment notes"):
        add(pid, 10, segment="healthcare", run_id=run.id)
    add(pid, 11, segment="healthcare", kind="news", thesis_relation="invalidates", run_id=run.id)
