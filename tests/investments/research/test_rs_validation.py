"""Pure validation of research notes and runs: sources (URL, publisher, date) required, URL rules
(http(s), public host, no paywall bypass), length limits, enums, details whitelist (no amounts /
targets / sizes), candidate details, recommendation / prediction phrases, dates, run scope and
counts. Synthetic input only."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.modules.investments.research.validation import (
    ResearchInputError,
    advice_problem,
    check_url,
    parse_moment,
    validate_counts,
    validate_note,
    validate_scope,
)

NOW = dt.datetime(2026, 10, 8, 12, 0, tzinfo=dt.UTC)
SOURCE = {
    "url": "https://example.com/news/2026/10/07/spolka-x-wyniki",
    "publisher": "Example News",
    "published_at": "2026-10-07",
    "title": "Spolka X po wynikach",
}


def base(**changes) -> dict:
    raw = {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": "Spolka X obniza prognoze sprzedazy",
        "summary": "Zarzad obnizyl prognoze sprzedazy na rok 2026; raport kwartalny z 7.10.",
        "sources": [dict(SOURCE)],
    }
    raw.update(changes)
    return raw


def issues(raw: dict) -> list[str]:
    with pytest.raises(ResearchInputError) as e:
        validate_note(raw, now=NOW)
    return [where for where, _ in e.value.issues]


def test_a_valid_note_is_normalized():
    data = validate_note(base(theme="  Handel   detaliczny "), now=NOW)
    assert data.theme == "Handel detaliczny"
    assert data.thesis_relation == "none" and data.expires_in_days == 30
    assert data.sources[0].as_json()["published_at"] == "2026-10-07"
    assert data.expires_at(NOW) == NOW + dt.timedelta(days=30)


def test_sources_are_required_with_url_publisher_and_date():
    assert issues(base(sources=[])) == ["sources"]
    assert "sources[0].url" in issues(base(sources=[{**SOURCE, "url": None}]))
    assert "sources[0].publisher" in issues(base(sources=[{**SOURCE, "publisher": ""}]))
    assert "sources[0].published_at" in issues(base(sources=[{**SOURCE, "published_at": None}]))
    assert "sources[0].published_at" in issues(
        base(sources=[{**SOURCE, "published_at": "2026-12-01"}])  # future
    )
    assert "sources[0]" in issues(base(sources=[{**SOURCE, "amount": 5}]))
    assert "sources[1].url" in issues(base(sources=[SOURCE, SOURCE]))  # listed twice
    assert issues(base(sources=[SOURCE] * 11)) == ["sources"]


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/a",
        "https://localhost/a",
        "http://127.0.0.1/a",
        "https://user:pw@example.com/a",
        "https://intranet/a",
        "https://archive.ph/abc",
        "https://www.12ft.io/proxy?q=https://example.com",
        "https://example.com/a b",
        "https://" + "a" * 600 + ".com",
    ],
)
def test_bad_urls_are_refused(url):
    assert check_url(url) is not None


def test_good_url():
    assert check_url("https://www.example.pl/rynki/artykul,123.html?x=1") is None


def test_lengths_and_enums():
    assert "title" in issues(base(title="x" * 121))
    assert "title" in issues(base(title="ab"))
    assert validate_note(base(title="two\n lines"), now=NOW).title == "two lines"
    assert "title" in issues(base(title="bell\x07char"))
    assert "summary" in issues(base(summary="z" * 1201))
    assert "kind" in issues(base(kind="rumour"))
    assert "polarity" in issues(base(polarity="bullish"))
    assert "strength" in issues(base(strength=4))
    assert "strength" in issues(base(strength=True))
    assert "thesis_relation" in issues(base(thesis_relation="kills"))
    assert "thesis_field" in issues(base(thesis_field="entry"))
    assert "thesis_field" in issues(base(thesis_field="exit_plan"))  # relation none
    assert "theme" in issues(base(theme="x" * 61))
    assert "expires_in_days" in issues(base(expires_in_days=91))


def test_details_whitelist_refuses_amounts_and_targets():
    assert issues(base(details={"price_target": 120})) == ["details"]
    assert issues(base(details={"position_size": 1000})) == ["details"]
    assert "details.criteria" in issues(base(details={"criteria": []}))
    assert "details.scale" in issues(base(details={"scale": "large"}))  # not community
    data = validate_note(
        base(kind="community", details={"scale": "small", "context": "watek na forum"}), now=NOW
    )
    assert data.details == {"scale": "small", "context": "watek na forum"}
    event = validate_note(base(details={"event": "wyniki Q3", "event_date": "2026-10-22"}), now=NOW)
    assert event.details == {"event": "wyniki Q3", "event_date": "2026-10-22"}
    assert "details.event_date" in issues(base(details={"event": "wyniki Q3"}))


def test_candidate_needs_identity_entry_type_and_criteria():
    candidate = base(
        kind="candidate",
        polarity="positive",
        candidate={"symbol_or_isin": "NEWCO.WA", "name": "Newco SA"},
        details={
            "entry_type": "sentiment_correction",
            "criteria": [
                {"text": "C/Z 9,8", "met": True, "threshold": "max 15"},
                {"text": "dywidenda 1,2%", "met": False},
            ],
            "criteria_version": 3,
        },
    )
    data = validate_note(candidate, now=NOW)
    assert data.candidate.key == "NEWCO.WA"
    assert data.details["criteria"][1] == {
        "text": "dywidenda 1,2%",
        "met": False,
        "threshold": None,
    }
    assert "details" in issues({**candidate, "details": None})
    assert "details.entry_type" in issues(
        {**candidate, "details": {"criteria": [{"text": "a b", "met": True}]}}
    )
    assert "thesis_relation" in issues({**candidate, "thesis_relation": "supports"})
    assert "candidate.symbol_or_isin" in issues(
        {**candidate, "candidate": {"symbol_or_isin": "a b"}}
    )
    assert "candidate" in issues(base(candidate={"symbol_or_isin": "NEWCO.WA"}))  # not a candidate
    assert "details.entry_type" in issues(base(details={"entry_type": "trend"}))


@pytest.mark.parametrize(
    "text",
    [
        "Analitycy podnosza cene docelowa do 120 zl",
        "Bank X: rekomendacja kupuj dla spolki",
        "Upgrade to buy after earnings",
        "Strong buy rating reiterated",
        "Kurs wzrosnie do 50 zl w tym roku",
        "The stock will reach 300 by spring",
        "Warto kupic przed dywidenda",
        "Price target raised",
    ],
)
def test_recommendations_ratings_and_predictions_are_refused(text):
    assert advice_problem(text)
    assert "title" in issues(base(title=text[:120]))


def test_plain_facts_pass_the_phrase_check():
    for text in (
        "Inwestorzy sprzedaja akcje po wynikach",
        "Kurs spadl o 8% po publikacji raportu",
        "Sprzedaz wzrosla r/r o 12%",
    ):
        assert not advice_problem(text)


def test_dates():
    assert parse_moment("2026-10-03") == dt.datetime(2026, 10, 3, tzinfo=dt.UTC)
    assert parse_moment("2026-10-03T08:00:00Z") == dt.datetime(2026, 10, 3, 8, tzinfo=dt.UTC)
    assert parse_moment("yesterday") is None
    assert "observed_at" in issues(base(observed_at="2026-11-01"))
    assert "observed_at" in issues(base(observed_at="2026-08-01"))  # already expired
    data = validate_note(base(observed_at="2026-09-20", expires_in_days=45), now=NOW)
    assert data.expires_at(NOW) == dt.datetime(2026, 11, 4, tzinfo=dt.UTC)


def test_scope_and_counts():
    scope = validate_scope({"themes": ["Banki", "banki", "Energia"], "scheduled": True})
    assert scope.themes == ("Banki", "Energia") and scope.scheduled and scope.held
    assert validate_scope(None).watchlist
    with pytest.raises(ResearchInputError):
        validate_scope({"everything": True})
    with pytest.raises(ResearchInputError):
        validate_scope({"held": "yes"})
    assert validate_counts({"sources_checked": 12}) == {"sources_checked": 12}
    with pytest.raises(ResearchInputError):
        validate_counts({"notes": 5})  # the server counts notes
    with pytest.raises(ResearchInputError):
        validate_counts({"skipped": -1})


def test_fulfills_names_the_thesis_or_its_exit_plan_p1():
    for field in ("thesis", "exit_plan", None):
        raw = base(thesis_relation="fulfills", polarity="positive")
        if field is not None:
            raw["thesis_field"] = field
        data = validate_note(raw, now=NOW)
        assert data.thesis_relation == "fulfills" and data.thesis_field == field
    for field in ("invalidation", "size_plan", "entry_type"):
        assert issues(base(thesis_relation="fulfills", thesis_field=field)) == ["thesis_field"]
    # weakens still takes any field
    assert validate_note(base(thesis_relation="weakens", thesis_field="size_plan"), now=NOW)
