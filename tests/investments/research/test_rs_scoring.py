"""Pure research scoring: ISO weeks, weekly sentiment (community capped, candidates ignored, dismissed
excluded, empty weeks None), direction, thesis health (7 states, 30-day window, notes before a core thesis edit tagged, never dropped)
and theme keys. Synthetic notes only."""

from __future__ import annotations

import datetime as dt
from itertools import pairwise

from cashu.modules.investments.research.scoring import (
    HEALTH_ORDER,
    Direction,
    Health,
    ScoredNote,
    direction,
    health_rank,
    iso_week,
    note_weight,
    sentiment_weeks,
    theme_key,
    thesis_health,
    week_start,
    week_starts,
)

NOW = dt.datetime(2026, 10, 8, 12, 0, tzinfo=dt.UTC)  # a Thursday, ISO week 2026-W41


def note(
    i: int,
    *,
    days_ago: float = 1,
    kind: str = "news",
    polarity: str = "positive",
    strength: int = 2,
    relation: str = "none",
    dismissed_days_ago: float | None = None,
    stored_days_ago: float | None = None,
    ttl_days: int = 30,
) -> ScoredNote:
    observed = NOW - dt.timedelta(days=days_ago)
    stored = NOW - dt.timedelta(days=stored_days_ago if stored_days_ago is not None else days_ago)
    return ScoredNote(
        id=i,
        kind=kind,
        polarity=polarity,
        strength=strength,
        thesis_relation=relation,
        observed_at=observed,
        created_at=stored,
        expires_at=observed + dt.timedelta(days=ttl_days),
        dismissed_at=None
        if dismissed_days_ago is None
        else NOW - dt.timedelta(days=dismissed_days_ago),
    )


def test_iso_weeks():
    assert iso_week(dt.date(2026, 10, 5)) == "2026-W41"
    assert iso_week(dt.date(2027, 1, 1)) == "2026-W53"
    assert week_start(dt.date(2026, 10, 11)) == dt.date(2026, 10, 5)
    starts = week_starts(dt.date(2026, 10, 7))
    assert len(starts) == 8 and starts[-1] == dt.date(2026, 10, 5)
    assert starts[0] == dt.date(2026, 8, 17)
    assert all((b - a).days == 7 for a, b in pairwise(starts))


def test_weekly_score_formula_and_empty_weeks():
    notes = [
        note(1, days_ago=0.5, polarity="positive", strength=3),  # this week
        note(2, days_ago=0.2, polarity="negative", strength=1),  # this week
        note(3, days_ago=8, polarity="negative", strength=3),  # last week
    ]
    values = sentiment_weeks(notes, NOW)
    assert len(values) == 8
    assert values[-1] == round((3 - 1) / (3 * 2), 4)
    assert values[-2] == -1.0
    assert values[:-2] == [None] * 6  # no notes = None, not 0


def test_community_is_capped_at_strength_one():
    assert note_weight("community", 3) == 1
    assert note_weight("news", 3) == 3
    values = sentiment_weeks([note(1, kind="community", polarity="positive", strength=3)], NOW)
    assert values[-1] == round(1 / 3, 4)


def test_candidates_and_dismissed_notes_do_not_count_but_expired_do():
    notes = [
        note(1, kind="candidate", polarity="positive", strength=3),
        note(2, polarity="negative", strength=3, dismissed_days_ago=0.1),
        note(3, days_ago=50, polarity="negative", strength=3, ttl_days=30),  # expired, 8 weeks
    ]
    values = sentiment_weeks(notes, NOW)
    assert values[-1] is None
    assert values[0] == -1.0 or values[1] == -1.0


def test_scoring_as_of_an_earlier_moment():
    then = NOW - dt.timedelta(days=7)
    notes = [
        note(1, days_ago=9, polarity="positive", strength=3),
        note(2, days_ago=1, polarity="negative", strength=3),  # stored after `then`
        note(3, days_ago=9, polarity="negative", strength=3, dismissed_days_ago=2),
    ]
    values_then = sentiment_weeks(notes, then)
    # note 2 did not exist yet; note 3 was not dismissed yet -> (3 - 3) / 6 = 0
    assert values_then[-1] == 0.0
    assert sentiment_weeks(notes, NOW)[-2] == 1.0


def test_direction_last_four_vs_previous_four():
    assert direction([None] * 8) is Direction.STABLE
    assert direction([0.5, 0.5, 0.5, 0.5, -0.5, None, -0.5, -0.5]) is Direction.FALLING
    assert direction([-0.5, -0.5, None, None, 0.5, 0.5, 0, 0]) is Direction.RISING
    assert direction([0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.3]) is Direction.STABLE


def test_health_states():
    sup = note(1, relation="supports")
    weak = note(2, relation="weakens")
    inv = note(3, relation="invalidates")
    neutral = note(4, relation="neutral")
    assert thesis_health([sup, weak, inv], NOW, has_thesis=True).state is Health.INVALIDATED
    assert thesis_health([sup, weak], NOW, has_thesis=True).state is Health.WEAKENED
    assert thesis_health([sup, neutral], NOW, has_thesis=True).state is Health.SUPPORTED
    assert thesis_health([neutral], NOW, has_thesis=True).state is Health.CURRENT
    assert thesis_health([], NOW, has_thesis=True).state is Health.NO_RESEARCH
    assert thesis_health([], NOW, has_thesis=True, researched=True).state is Health.CURRENT
    result = thesis_health([sup, weak], NOW, has_thesis=False)
    assert result.state is Health.NO_THESIS and result.counts["weakens"] == 1
    counted = thesis_health(
        [sup, weak, note(5, kind="community", relation="weakens")], NOW, has_thesis=True
    )
    assert counted.counts == {
        "supports": 1,
        "weakens": 2,
        "invalidates": 0,
        "fulfills": 0,
        "neutral": 0,
        "community": 1,
    }
    assert counted.relation == "weakens" and set(counted.note_ids) == {1, 2, 5}


def test_health_window_dismissal_expiry():
    old = note(1, days_ago=31, relation="invalidates", ttl_days=60)  # outside 30 days
    dismissed = note(2, relation="invalidates", dismissed_days_ago=0.5)
    expired = note(3, days_ago=10, relation="invalidates", ttl_days=5)
    assert thesis_health([old, dismissed, expired], NOW, has_thesis=True).state is (
        Health.NO_RESEARCH
    )


def test_a_thesis_edit_keeps_the_notes_and_only_tags_them():
    """P2 (owner decision): research stored before the thesis' last core change still counts; the
    result only says the deciding notes predate the thesis."""
    before_edit = note(4, days_ago=3, relation="weakens")
    edited = NOW - dt.timedelta(days=1)
    result = thesis_health([before_edit], NOW, has_thesis=True, thesis_changed_at=edited)
    assert result.state is Health.WEAKENED and result.counts["weakens"] == 1
    assert result.note_ids == (4,) and result.predates_thesis is True
    untouched = thesis_health([before_edit], NOW, has_thesis=True)
    assert untouched.state is Health.WEAKENED and untouched.predates_thesis is False


def test_a_new_note_after_the_edit_wins_by_precedence_and_untags():
    edited = NOW - dt.timedelta(days=2)
    old_support = note(1, days_ago=5, relation="supports")
    new_weakens = note(2, days_ago=1, relation="weakens")
    result = thesis_health(
        [old_support, new_weakens], NOW, has_thesis=True, thesis_changed_at=edited
    )
    assert result.state is Health.WEAKENED and result.predates_thesis is False
    # a new supporting note next to an old invalidating one: invalidated still wins, tagged
    old_invalidates = note(3, days_ago=5, relation="invalidates")
    new_supports = note(4, days_ago=1, relation="supports")
    result = thesis_health(
        [old_invalidates, new_supports], NOW, has_thesis=True, thesis_changed_at=edited
    )
    assert result.state is Health.INVALIDATED and result.predates_thesis is True
    # one deciding note after the edit is enough to untag
    newer_invalidates = note(5, days_ago=0.5, relation="invalidates")
    result = thesis_health(
        [old_invalidates, newer_invalidates], NOW, has_thesis=True, thesis_changed_at=edited
    )
    assert result.state is Health.INVALIDATED and result.predates_thesis is False


def test_states_without_deciding_notes_are_never_tagged():
    edited = NOW - dt.timedelta(days=1)
    neutral = note(1, days_ago=3, relation="neutral")
    assert thesis_health([neutral], NOW, has_thesis=True, thesis_changed_at=edited) == (
        thesis_health([neutral], NOW, has_thesis=True)
    )
    result = thesis_health([neutral], NOW, has_thesis=True, thesis_changed_at=edited)
    assert result.state is Health.CURRENT and result.predates_thesis is False
    result = thesis_health([], NOW, has_thesis=True, thesis_changed_at=edited)
    assert result.state is Health.NO_RESEARCH and result.predates_thesis is False
    result = thesis_health([note(2, relation="weakens")], NOW, has_thesis=False)
    assert result.state is Health.NO_THESIS and result.predates_thesis is False


def test_health_order_and_rank():
    assert HEALTH_ORDER == (
        Health.INVALIDATED,
        Health.WEAKENED,
        Health.FULFILLED,
        Health.NO_RESEARCH,
        Health.NO_THESIS,
        Health.SUPPORTED,
        Health.CURRENT,
    )
    assert health_rank("invalidated") < health_rank("weakened") < health_rank("current")
    assert health_rank("weakened") < health_rank("fulfilled") < health_rank("no_research")
    assert health_rank("bogus") == 7


def test_theme_keys_group_case_and_accents():
    assert theme_key("Półprzewodniki") == theme_key("  polprzewodniki ")
    assert theme_key("Stopy procentowe (NBP)") == "stopy-procentowe-nbp"
    assert theme_key("!!!") == "theme"


def test_fulfilled_health_precedence_p1():
    """P1: invalidated > weakened > fulfilled > supported > current; fulfills ranks between weakens
    and supports and bears on the thesis."""
    sup, ful = note(1, relation="supports"), note(2, relation="fulfills")
    weak, inv = note(3, relation="weakens"), note(4, relation="invalidates")
    fulfilled = thesis_health([sup, ful], NOW, has_thesis=True)
    assert fulfilled.state is Health.FULFILLED and fulfilled.relation == "fulfills"
    assert fulfilled.counts["fulfills"] == 1 and set(fulfilled.note_ids) == {1, 2}
    assert thesis_health([ful, weak], NOW, has_thesis=True).state is Health.WEAKENED
    assert thesis_health([ful, inv], NOW, has_thesis=True).state is Health.INVALIDATED
    assert thesis_health([sup], NOW, has_thesis=True).state is Health.SUPPORTED
    assert thesis_health([ful], NOW, has_thesis=False).state is Health.NO_THESIS
    assert Health.FULFILLED.value == "fulfilled"
