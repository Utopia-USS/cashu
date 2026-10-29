"""strategy.yaml ``review:`` (the owner's periodic review: frequency, weekday, name, deck cards) and the
review schedule of the digest (due / next day for week, 2weeks and month)."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.modules.investments.service.views import review_schedule
from cashu.modules.investments.strategy.config import REVIEW_CARDS, Weekday
from cashu.modules.investments.strategy.loader import load_strategy

BASE = "version: 1\nbase_currency: PLN\n"


def test_defaults_without_a_review_section():
    review = load_strategy(BASE).config.review
    assert (review.every, review.day, review.cards, review.title) == ("week", None, REVIEW_CARDS, "Przegląd tygodnia")


def test_review_section_is_parsed():
    text = BASE + "review:\n  every: month\n  day: Saturday\n  cards: [world, decide, calendar]\n"
    review = load_strategy(text).config.review
    assert review.every == "month" and review.day == Weekday.SATURDAY
    assert review.cards == ("world", "decide", "calendar")
    assert review.title == "Przegląd miesiąca"
    named = load_strategy(BASE + "review:\n  name: Niedzielna kawa\n").config.review
    assert named.title == "Niedzielna kawa"


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("every: daily", 'Unknown review frequency "daily"'),
        ("day: niedziela", 'Unknown weekday "niedziela"'),
        ("cards: [world, wordl]", 'Unknown review card "wordl"'),
        ("name: " + "x" * 41, "longer than 40 characters"),
    ],
)
def test_invalid_review_settings_are_errors(body, message):
    result = load_strategy(BASE + "review:\n  " + body + "\n")
    assert result.config is None
    assert any(message in issue.message and issue.path.startswith("review") for issue in result.issues), result.issues


def test_unknown_review_key_is_a_warning():
    result = load_strategy(BASE + "review:\n  evry: week\n")
    assert result.config is not None
    assert any(issue.path == "review.evry" for issue in result.issues)


SUN = dt.date(2026, 11, 1)


def test_weekly_schedule():
    assert review_schedule("week", 7, SUN, None) == (True, SUN + dt.timedelta(7))
    assert review_schedule("week", 7, SUN, SUN) == (False, SUN + dt.timedelta(7))
    assert review_schedule("week", 7, SUN + dt.timedelta(3), SUN - dt.timedelta(1))[0] is True


def test_two_week_schedule_skips_the_week_after_a_review():
    assert review_schedule("2weeks", 7, SUN + dt.timedelta(7), SUN)[0] is False
    assert review_schedule("2weeks", 7, SUN + dt.timedelta(14), SUN)[0] is True
    assert review_schedule("2weeks", 7, SUN, SUN)[1] == SUN + dt.timedelta(14)


def test_monthly_schedule_falls_on_the_first_weekday_of_the_month():
    assert review_schedule("month", 7, dt.date(2026, 11, 10), dt.date(2026, 11, 1)) == (False, dt.date(2026, 12, 6))
    assert review_schedule("month", 7, dt.date(2026, 12, 6), dt.date(2026, 11, 1))[0] is True
    assert review_schedule("month", 7, dt.date(2026, 12, 5), dt.date(2026, 11, 1))[0] is False
