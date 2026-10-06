"""Research service against a real DB: runs (conflict, stale -> failed, counts), note rules (scope,
thesis relation, owner-named refusal, duplicates, theme spelling), research signals through the
lifecycle (action / info, notification policy, one signal per instrument and week, escalation,
polarity), dismiss / restore (the signal resolves and reopens), housekeeping on expiry, candidates
(new instruments only, cooldown, accept -> watchlist + draft thesis, undo), the review-digest block and
the summary. Synthetic data only."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import add_account, canonical_csv, import_file, make_profile
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile, utcnow
from cashu.modules.investments.models import (
    InvInstrument,
    InvNotification,
    InvResearchNote,
    InvResearchRun,
    InvSignal,
    InvWatchlistItem,
)
from cashu.modules.investments.research import service, views
from cashu.modules.investments.research.signals import CLOSED_DISMISSED, CLOSED_EXPIRED
from cashu.modules.investments.research.validation import RunScope, validate_note
from cashu.modules.investments.store import journal

SOURCE = {"url": "https://example.com/news/a", "publisher": "Example News", "published_at": None}


@pytest.fixture
def investor(db_engine):
    pid, _slug = make_profile("Badacz")
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    return pid


def iid(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def thesis(pid: int, symbol: str = "XMPL") -> int:
    with get_session() as s:
        return journal.create_thesis(
            s, pid, iid(symbol), {"entry_type": "trend", "thesis": "Example thesis"}
        ).id


def raw(n: int = 1, **changes) -> dict:
    data = {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": f"Example fact number {n}",
        "summary": "Przykladowy fakt ze zrodla, opisany neutralnie.",
        "sources": [
            {
                **SOURCE,
                "url": f"https://example.com/news/{n}",
                "published_at": utcnow().date().isoformat(),
            }
        ],
    }
    data.update(changes)
    return data


def add(pid: int, n: int = 1, *, instrument: str | None = "XMPL", run_id=None, now=None, **changes):
    with get_session() as s:
        profile = s.get(Profile, pid)
        data = validate_note(raw(n, **changes), now=now or utcnow())
        ref = service.resolve_reference(s, pid, instrument) if instrument else None
        added = service.add_note(s, profile, data, instrument_id=ref, run_id=run_id, now=now)
        return added.note.id, added.signal


def call(pid: int, fn, *args, **kwargs):
    with get_session() as s:
        return fn(s, s.get(Profile, pid), *args, **kwargs)


def signals(pid: int) -> list[InvSignal]:
    with get_session() as s:
        return list(
            s.exec(
                select(InvSignal)
                .where(InvSignal.profile_id == pid, InvSignal.dedup_key.startswith("research:"))
                .order_by(InvSignal.id)
            ).all()
        )


def notifications(pid: int, signal_id: int) -> list[InvNotification]:
    with get_session() as s:
        return list(
            s.exec(select(InvNotification).where(InvNotification.signal_id == signal_id)).all()
        )


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def test_run_lifecycle(investor):
    pid = investor
    run = call(pid, service.start_run, RunScope(themes=("Banki",), scheduled=True))
    assert run.status == "running"
    assert set(run.scope["covered_instrument_ids"]) == {iid("ABC"), iid("WRLD"), iid("XMPL")}
    assert run.scope["scheduled"] is True
    with pytest.raises(service.ResearchConflict):
        call(pid, service.start_run, RunScope())
    note_id, _ = add(pid)  # no run_id: joins the running run
    with get_session() as s:
        assert s.get(InvResearchNote, note_id).run_id == run.id
    done = call(pid, service.finish_run, run.id, counts={"sources_checked": 7})
    assert done.status == "done" and done.finished_at is not None
    assert done.counts["notes"] == 1 and done.counts["by_kind"] == {"news": 1}
    assert done.counts["sources_checked"] == 7
    with pytest.raises(service.ResearchConflict):
        call(pid, service.finish_run, run.id)
    with pytest.raises(service.ResearchNotFound):
        call(pid, service.finish_run, run.id + 99)
    with pytest.raises(service.ResearchConflict):
        add(pid, 2, run_id=run.id)  # the run is done


def test_stale_run_is_marked_failed(investor):
    pid = investor
    old = utcnow() - dt.timedelta(hours=5)
    run = call(pid, service.start_run, RunScope(), now=old)
    with get_session() as s:
        row = s.get(InvResearchRun, run.id)
        assert views.run_dict(s, row)["status"] == "failed"  # shown as interrupted at once
    fresh = call(pid, service.start_run, RunScope())
    with get_session() as s:
        row = s.get(InvResearchRun, run.id)
        assert row.status == "failed" and row.counts["reason"] == "interrupted"
        assert views.run_dict(s, row)["interrupted"] is True
    assert fresh.status == "running"
    with pytest.raises(service.ResearchConflict):
        call(pid, service.finish_run, run.id)


def test_finish_failed_with_reason_and_bad_counts(investor):
    pid = investor
    run = call(pid, service.start_run, RunScope())
    with pytest.raises(service.ResearchError):
        call(pid, service.finish_run, run.id, counts={"notes": 3})
    with pytest.raises(service.ResearchError):
        call(pid, service.finish_run, run.id, status="cancelled")
    row = call(pid, service.finish_run, run.id, status="failed", reason="limit sesji")
    assert row.status == "failed" and row.counts["reason"] == "limit sesji"


# --------------------------------------------------------------------------- #
# Note rules
# --------------------------------------------------------------------------- #


def test_note_scope_and_thesis_rules(investor):
    pid = investor
    with pytest.raises(service.ResearchError):
        add(pid, instrument=None)  # neither instrument nor theme
    with pytest.raises(service.ResearchError):
        add(pid, thesis_relation="weakens")  # XMPL has no thesis yet
    with pytest.raises(service.ResearchError):
        add(pid, instrument=None, theme="Banki", thesis_relation="neutral")
    thesis(pid)
    _note_id, signal = add(pid, thesis_relation="weakens", thesis_field="invalidation")
    assert signal is None  # weakens with strength 2: no signal
    with pytest.raises(service.ResearchNotFound):
        add(pid, 2, instrument="NOPE")
    by_isin, _ = add(pid, 3, instrument="PLABC0000016")
    with get_session() as s:
        assert s.get(InvResearchNote, by_isin).instrument_id == iid("ABC")
    first, _ = add(pid, 4, instrument=None, theme="Półprzewodniki")
    second, _ = add(pid, 5, instrument=None, theme="  polprzewodniki ")
    with get_session() as s:
        assert s.get(InvResearchNote, second).theme == "Półprzewodniki"  # first spelling kept
        assert s.get(InvResearchNote, first).expires_at is not None


def test_duplicates_are_refused(investor):
    pid = investor
    add(pid, 1)
    with pytest.raises(service.ResearchConflict, match="duplicate"):
        add(pid, 2, title="Example fact number 1")
    with pytest.raises(service.ResearchConflict, match="duplicate"):
        add(pid, 1, title="Another title")  # same first source URL
    add(pid, 1, instrument="ABC")  # another scope: fine
    theme_note, _ = add(pid, 7, instrument=None, theme="Banki")
    call(pid, service.dismiss, theme_note)
    with pytest.raises(service.ResearchConflict, match="dismissed by the owner"):
        add(pid, 8, instrument=None, theme="banki", title="Example fact number 7")


def test_owner_named_instruments_are_never_researched(investor):
    pid = investor
    with get_session() as s:
        claim = InvInstrument(
            name="Pozyczka Jan Przykladowy",
            symbol="PRYWATNA",
            currency="PLN",
            asset_class="claim",
            valuation_mode="manual",
            tags=[],
        )
        s.add(claim)
        s.flush()
        from cashu.modules.investments.models import InvManualValuation

        s.add(
            InvManualValuation(
                profile_id=pid,
                instrument_id=claim.id,
                as_of=dt.date(2026, 1, 1),
                unit_value=1,
                currency="PLN",
            )
        )
    with pytest.raises(service.ResearchError, match="owner-named"):
        add(pid, instrument="PRYWATNA")


# --------------------------------------------------------------------------- #
# Signals
# --------------------------------------------------------------------------- #


def test_invalidating_note_is_an_action_signal_with_a_notification(investor):
    pid = investor
    thesis(pid)
    note_id, sync = add(pid, polarity="negative", thesis_relation="invalidates")
    assert sync is not None and sync.created
    (sig,) = signals(pid)
    assert sig.severity == "action" and sig.polarity == "negative" and sig.status == "active"
    assert sig.rule_id == sig.kind == "research:news"
    assert sig.instrument_id == iid("XMPL")
    assert sig.dedup_key.startswith("research:") and sig.dedup_key.endswith(f"|i:{iid('XMPL')}")
    assert sig.payload["note_id"] == note_id and sig.payload["relation"] == "invalidates"
    assert len(notifications(pid, sig.id)) == 1  # default policy notifies action
    with get_session() as s:
        assert s.get(InvResearchNote, note_id).signal_id == sig.id


def test_strength_three_is_info_and_later_notes_join_the_weekly_signal(investor):
    pid = investor
    thesis(pid)
    first, sync = add(pid, 1, polarity="positive", strength=3)
    (sig,) = signals(pid)
    assert sig.severity == "info" and sig.polarity == "positive"
    assert notifications(pid, sig.id) == []  # info is not in the default immediate policy
    add(pid, 2, strength=1)  # does not qualify: nothing changes
    second, sync = add(pid, 3, polarity="negative", strength=2, thesis_relation="invalidates")
    assert sync.escalated and not sync.created
    (sig,) = signals(pid)  # still one signal for XMPL this week
    assert sig.severity == "action" and sig.polarity == "negative"
    assert sig.payload["note_id"] == second and set(sig.payload["note_ids"]) == {first, second}
    assert len(notifications(pid, sig.id)) == 1
    add(pid, 4, instrument=None, theme="Banki", strength=3)
    assert len(signals(pid)) == 2  # a theme has its own signal
    candidate = add(
        pid,
        5,
        instrument=None,
        kind="candidate",
        strength=3,
        candidate={"symbol_or_isin": "NEWCO.WA", "name": "Newco"},
        details={"entry_type": "trend", "criteria": [{"text": "C/Z 9", "met": True}]},
    )
    assert candidate[1] is None and len(signals(pid)) == 2  # candidates never become signals


def test_dismiss_resolves_and_restore_reopens_the_signal(investor):
    pid = investor
    thesis(pid)
    note_id, _ = add(pid, thesis_relation="invalidates")
    (sig,) = signals(pid)
    t0 = utcnow()
    call(pid, service.dismiss, note_id, now=t0)
    (sig,) = signals(pid)
    assert sig.status == "resolved" and sig.payload["closed_reason"] == CLOSED_DISMISSED
    call(pid, service.restore, note_id, now=t0 + dt.timedelta(minutes=5))
    (again,) = signals(pid)
    assert again.id == sig.id and again.status == "active" and again.closed_at is None
    assert "closed_reason" not in again.payload
    assert len(notifications(pid, sig.id)) == 1  # no second notification
    call(pid, service.dismiss, note_id, now=t0 + dt.timedelta(minutes=6))
    with pytest.raises(service.UndoExpired):
        call(pid, service.restore, note_id, now=t0 + dt.timedelta(minutes=22))
    with get_session() as s:
        assert s.get(InvResearchNote, note_id).dismissed_at is not None


def test_dismissing_one_of_two_notes_keeps_the_signal_open(investor):
    pid = investor
    thesis(pid)
    weak, _ = add(pid, 1, strength=3, polarity="positive")
    strong, _ = add(pid, 2, thesis_relation="invalidates")
    call(pid, service.dismiss, strong)
    (sig,) = signals(pid)
    assert sig.status == "active" and sig.payload["note_id"] == weak
    assert sig.polarity == "positive"


def test_housekeeping_resolves_signals_of_expired_notes(investor):
    pid = investor
    add(pid, strength=3, expires_in_days=1)
    (sig,) = signals(pid)
    stats = call(pid, service.housekeeping, now=utcnow() + dt.timedelta(days=2))
    assert stats["research_signals_resolved"] == 1
    (sig,) = signals(pid)
    assert sig.status == "resolved" and sig.payload["closed_reason"] == CLOSED_EXPIRED
    assert call(pid, service.housekeeping)["research_signals_resolved"] == 0


# --------------------------------------------------------------------------- #
# Candidates
# --------------------------------------------------------------------------- #

CANDIDATE = {
    "kind": "candidate",
    "polarity": "positive",
    "candidate": {"symbol_or_isin": "NEWCO.WA", "name": "Newco SA"},
    "details": {
        "entry_type": "sentiment_correction",
        "criteria": [{"text": "C/Z 9,8", "met": True, "threshold": "max 15"}],
    },
}


def test_candidate_rules_and_cooldown(investor):
    pid = investor
    with pytest.raises(service.ResearchConflict, match="already held"):
        add(pid, instrument="ABC", **{k: v for k, v in CANDIDATE.items() if k != "candidate"})
    with pytest.raises(service.ResearchConflict, match="already held"):
        add(pid, instrument=None, **{**CANDIDATE, "candidate": {"symbol_or_isin": "XMPL"}})
    note_id, _ = add(pid, instrument=None, **CANDIDATE)
    with pytest.raises(service.ResearchConflict, match="already proposed"):
        add(pid, 2, instrument=None, **CANDIDATE)
    row = call(pid, service.dismiss, note_id)
    assert row.cooldown_until is not None
    assert (service.aware(row.cooldown_until) - service.aware(row.dismissed_at)).days == 90
    with pytest.raises(service.ResearchConflict, match="do not propose it again"):
        add(pid, 3, instrument=None, **CANDIDATE)
    restored = call(pid, service.restore, note_id)
    assert restored.cooldown_until is None


def test_accept_candidate_and_undo(investor):
    pid = investor
    note_id, _ = add(pid, instrument=None, **CANDIDATE)
    result = call(pid, service.accept_candidate, note_id)
    with get_session() as s:
        item = s.get(InvWatchlistItem, result.watchlist_item_id)
        assert item.source == "user" and item.note.startswith("kandydat: ")
        theses = journal.theses(s, pid, item.instrument_id)
        assert theses[0].entry_type == "sentiment_correction" and theses[0].reviewed_at is None
        note = s.get(InvResearchNote, note_id)
        assert note.instrument_id == item.instrument_id and note.details["accepted_at"]
    with pytest.raises(service.ResearchConflict):
        call(pid, service.accept_candidate, note_id)
    call(pid, service.undo_accept, note_id)
    with get_session() as s:
        assert s.get(InvWatchlistItem, result.watchlist_item_id) is None
        assert journal.theses(s, pid, item.instrument_id) == []
        note = s.get(InvResearchNote, note_id)
        assert note.instrument_id is None and "accepted_at" not in (note.details or {})
    accepted = call(pid, service.accept_candidate, note_id)
    with pytest.raises(service.UndoExpired):
        call(pid, service.undo_accept, note_id, now=utcnow() + dt.timedelta(minutes=20))
    assert accepted.thesis is not None
    news_id, _ = add(pid, 9)
    with pytest.raises(service.ResearchConflict):
        call(pid, service.accept_candidate, news_id)


def test_accept_keeps_an_existing_watch_and_thesis(investor):
    from cashu.modules.investments.service import watchlist as watch_service

    pid = investor
    note_id, _ = add(pid, instrument=None, **CANDIDATE)
    with get_session() as s:
        profile = s.get(Profile, pid)
        watched = watch_service.add(s, profile, "NEWCO.WA", note="moja obserwacja")
        journal.create_thesis(
            s, pid, watched.item.instrument_id, {"entry_type": "trend", "thesis": "Moja teza"}
        )
        item_id = watched.item.id
    result = call(pid, service.accept_candidate, note_id)
    assert result.watchlist_item_id == item_id and result.thesis.thesis == "Moja teza"
    call(pid, service.undo_accept, note_id)
    with get_session() as s:
        assert s.get(InvWatchlistItem, item_id) is not None  # the owner's watch stays
        assert journal.theses(s, pid)[0].thesis == "Moja teza"


# --------------------------------------------------------------------------- #
# Summary and digest
# --------------------------------------------------------------------------- #


def test_summary_health_sentiment_and_themes(investor):
    pid = investor
    thesis(pid, "XMPL")
    thesis(pid, "ABC")
    add(pid, 1, thesis_relation="invalidates", thesis_field="invalidation", theme="Technologia")
    add(pid, 2, instrument="ABC", polarity="positive", thesis_relation="supports")
    add(pid, 3, instrument=None, theme="technologia", kind="community", strength=3)
    with get_session() as s:
        result = views.summary(s, s.get(Profile, pid), positions=[])
    rows = {r["label"]: r for r in result["instruments"]}
    assert result["instruments"][0]["label"] == "XMPL"  # invalidated first
    assert rows["XMPL"]["health"] == "invalidated" and rows["XMPL"]["counts"]["invalidates"] == 1
    assert rows["XMPL"]["fields"] == [
        {
            "field": "invalidation",
            "supports": 0,
            "weakens": 0,
            "invalidates": 1,
            "fulfills": 0,
            "neutral": 0,
        }
    ]
    assert rows["XMPL"]["sentiment_8w"][-1] == round(-2 / 3, 4)
    assert rows["ABC"]["health"] == "supported" and rows["ABC"]["latest_polarity"] == "positive"
    assert rows["XMPL"]["last_researched_at"] is not None
    (theme,) = result["themes"]
    assert theme["theme"] == "Technologia" and theme["notes"] == 2
    assert theme["instruments"] == [iid("XMPL")]
    # (-2 - 1) / (3 * 2): the community note counts with strength 1
    assert theme["sentiment_8w"][-1] == round(-3 / 6, 4)
    assert result["totals"]["signals_open"] == 2 and len(result["weeks"]) == 8


def test_research_digest_since_the_last_review(investor):
    pid = investor
    thesis(pid)
    before = utcnow()
    run = call(pid, service.start_run, RunScope())
    note_id, _ = add(pid, 1, thesis_relation="invalidates", run_id=run.id)
    add(pid, 2, instrument=None, theme="Energia", polarity="positive", strength=3)
    last_week = (utcnow() - dt.timedelta(days=8)).date().isoformat()
    add(pid, 4, instrument=None, theme="Energia", polarity="positive", observed_at=last_week)
    cand, _ = add(pid, 3, instrument=None, **CANDIDATE)
    with get_session() as s:
        block = views.research_digest(s, pid, before)
    assert block["ran_in_period"] and block["run"]["id"] == run.id
    assert block["notes_count"] == 4 and block["signals_count"] == 2
    assert block["counts"]["invalidates"] == 1 and block["by_kind"]["candidate"] == 1
    (changed,) = block["theses_changed"]
    assert changed["label"] == "XMPL" and changed["from"] == "no_research"
    assert changed["to"] == "invalidated" and changed["note_ids"] == [note_id]
    assert block["candidates"] == [cand] and block["highlights"][0] == note_id
    (theme,) = block["themes_changed"]
    assert theme["theme"] == "Energia" and (theme["from"], theme["to"]) == ("stable", "rising")
    with get_session() as s:
        empty = views.research_digest(s, pid, utcnow() + dt.timedelta(minutes=1))
    assert empty["notes_count"] == 0 and not empty["ran_in_period"]
    assert empty["theses_unchanged"] == 1


def test_the_daily_check_keeps_research_signals_open(investor):
    """Research signals are not strategy rules: the daily check must leave them alone (BE ask 1)."""
    from invp_support import AS_OF, STRATEGY_YAML, sources

    from cashu.modules.investments.service import daily, files

    pid = investor
    with get_session() as s:
        slug = s.get(Profile, pid).slug
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    thesis(pid)
    add(pid, thesis_relation="invalidates")
    daily.run_daily_check("manual", profile_ids=[pid], as_of=AS_OF, sources=sources())
    (sig,) = signals(pid)
    assert sig.status == "active", sig.status
