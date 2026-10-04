"""Composite price source: order, fallback, blocking, attribution (port of composite_price_source_test)."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from inv_market_support import (
    FETCHED_AT,
    build_instrument,
    d,
    day,
    fake_clock,
    fixture,
    make_http,
    orlen,
    recording,
    respond,
    vwce,
)

from finanse.modules.investments.domain import (
    AssetClass,
    CalendarDate,
    Currency,
    Instrument,
    InstrumentAlias,
    PriceBar,
)
from finanse.modules.investments.market import (
    CompositePriceSource,
    NoPriceSourceException,
    PriceSource,
    QuoteCurrencyMismatchException,
    SourceBlockedException,
    SourceException,
)

FROM, TO = day("2026-09-28"), day("2026-10-02")


class FakeSource(PriceSource):
    """A scripted alias-based source: answers with bars, nothing, or raises."""

    def __init__(self, source_id: str, answer: Callable[[Instrument], list[PriceBar]]):
        self._id = source_id
        self.answer = answer
        self.calls: list[str] = []

    @property
    def id(self) -> str:
        return self._id

    def history(self, instrument: Instrument, start: CalendarDate, end: CalendarDate):
        self.calls.append(instrument.alias(self._id))
        return self.answer(instrument)


def bars_from(source: str, instrument: Instrument) -> list[PriceBar]:
    return [
        PriceBar(
            instrument_id=instrument.id,
            date=day("2026-10-02"),
            close=d("10"),
            source=source,
            fetched_at=FETCHED_AT,
        )
    ]


def raises(error: Exception):
    def answer(_):
        raise error

    return answer


def setup(stooq_answer=None, yahoo_answer=None):
    stooq = FakeSource("stooq", stooq_answer or (lambda i: bars_from("stooq", i)))
    yahoo = FakeSource("yahoo", yahoo_answer or (lambda i: bars_from("yahoo", i)))
    return stooq, yahoo, CompositePriceSource([yahoo, stooq])  # list order must not matter


def test_xwar_instruments_ask_stooq_first_and_attribute_the_bars_to_it():
    stooq, yahoo, composite = setup()
    bars = composite.history(orlen(), FROM, TO)
    assert bars[0].source == "stooq"
    assert stooq.calls == ["pkn"]
    assert yahoo.calls == []
    assert composite.id == "composite"


def test_other_instruments_ask_yahoo_first():
    stooq, yahoo, composite = setup()
    assert composite.history(vwce(), FROM, TO)[0].source == "yahoo"
    assert yahoo.calls == ["VWCE.DE"]
    assert stooq.calls == []


def test_a_failing_first_source_falls_back_to_the_next():
    stooq, yahoo, composite = setup(
        stooq_answer=raises(SourceException("stooq", "HTTP 500", retryable=True))
    )
    assert composite.history(orlen(), FROM, TO)[0].source == "yahoo"
    assert stooq.calls == ["pkn"]
    assert yahoo.calls == ["PKN.WA"]
    assert composite.health["stooq"].failures == 1
    assert composite.health["stooq"].last_error == "HTTP 500"
    assert composite.health["yahoo"].with_data == 1


def test_an_empty_first_answer_falls_back_to_the_next():
    _, _, composite = setup(stooq_answer=lambda _: [])
    assert composite.history(orlen(), FROM, TO)[0].source == "yahoo"
    assert composite.health["stooq"].empty == 1


def test_only_sources_with_an_alias_are_tried_and_a_guessed_alias_counts():
    stooq, _, composite = setup()
    only_yahoo = orlen(aliases=[InstrumentAlias("yahoo", "PKN.WA")])
    assert composite.history(only_yahoo, FROM, TO)[0].source == "yahoo"
    assert stooq.calls == []
    guessed = orlen(aliases=[InstrumentAlias("stooq", "pkn", guessed=True)])
    assert composite.history(guessed, FROM, TO)[0].source == "stooq"


def test_a_blocked_source_is_skipped_for_the_rest_of_the_run():
    stooq, _, composite = setup(
        stooq_answer=raises(SourceBlockedException("stooq", "browser verification page"))
    )
    composite.history(orlen(), FROM, TO)
    second = orlen(aliases=[InstrumentAlias("stooq", "pzu"), InstrumentAlias("yahoo", "PZU.WA")])
    assert composite.history(second, FROM, TO)[0].source == "yahoo"
    assert stooq.calls == ["pkn"]  # pzu never asked
    assert composite.health["stooq"].blocked is True
    assert composite.health["stooq"].attempts == 1
    assert composite.health["yahoo"].attempts == 2
    assert composite.health["stooq"].to_json()["blocked"] is True


def test_when_every_source_fails_one_exception_names_each_failure():
    _, _, composite = setup(
        stooq_answer=raises(SourceException("stooq", "malformed CSV row 3")),
        yahoo_answer=raises(SourceException("yahoo", "HTTP 503", retryable=True)),
    )
    with pytest.raises(SourceException) as caught:
        composite.history(orlen(), FROM, TO)
    assert caught.value.source_id == "composite"
    assert caught.value.message == "stooq: malformed CSV row 3; yahoo: HTTP 503"
    assert caught.value.retryable is True


def test_an_unexpected_exception_in_one_source_does_not_hide_the_others():
    _, _, composite = setup(stooq_answer=raises(ValueError("bug")))
    assert composite.history(orlen(), FROM, TO)[0].source == "yahoo"
    assert composite.health["stooq"].failures == 1


def test_no_bars_anywhere_but_one_answered_is_an_empty_list():
    _, _, composite = setup(
        stooq_answer=lambda _: [],
        yahoo_answer=raises(SourceException("yahoo", "HTTP 503", retryable=True)),
    )
    assert composite.history(orlen(), FROM, TO) == []


def test_an_instrument_without_any_source_alias_raises_no_price_source():
    stooq, yahoo, composite = setup()
    bond = build_instrument(
        name="EDO0136", symbol="EDO0136", mic=None, asset_class=AssetClass.TREASURY_BOND
    )
    with pytest.raises(NoPriceSourceException):
        composite.history(bond, FROM, TO)
    assert stooq.calls + yahoo.calls == []


def test_a_custom_order_is_honoured():
    stooq = FakeSource("stooq", lambda i: bars_from("stooq", i))
    yahoo = FakeSource("yahoo", lambda i: bars_from("yahoo", i))
    composite = CompositePriceSource([stooq, yahoo], order=lambda _: ["yahoo"])
    assert composite.history(orlen(), FROM, TO)[0].source == "yahoo"


def test_a_quote_currency_mismatch_is_reported_even_when_another_source_answered_empty_r3():
    mismatch = QuoteCurrencyMismatchException(
        "yahoo",
        "quote currency GBP differs from the instrument currency USD",
        quote_currency=Currency.GBP,
        instrument_currency=Currency.USD,
    )
    _, _, composite = setup(yahoo_answer=raises(mismatch), stooq_answer=lambda _: [])
    with pytest.raises(SourceException) as caught:
        composite.history(vwce(), FROM, TO)
    assert "yahoo: quote currency GBP" in caught.value.message
    assert caught.value.retryable is False

    # A plain failure next to an empty answer still means "no data in range".
    _, _, composite = setup(
        yahoo_answer=raises(SourceException("yahoo", "HTTP 500", retryable=True)),
        stooq_answer=lambda _: [],
    )
    assert composite.history(vwce(), FROM, TO) == []


def test_standard_composite_over_recorded_responses_stooq_bot_page_then_yahoo():
    requests = []

    def handler(request):
        if request.url.host == "stooq.pl":
            return respond(fixture("stooq_challenge.html"), 200, "text/html; charset=utf-8")
        return respond(fixture("yahoo_vwce_de.json"))

    standard = CompositePriceSource.standard(
        make_http(recording(requests, handler)), clock=fake_clock
    )
    # XWAR (stooq first); its yahoo alias quotes in EUR, so the instrument currency is EUR (R3).
    gpw_etf = build_instrument(
        name="Vanguard FTSE All-World (GPW listing)",
        symbol="VWCE",
        currency=Currency.EUR,
        aliases=[InstrumentAlias("stooq", "vwce"), InstrumentAlias("yahoo", "VWCE.DE")],
    )
    bars = standard.history(gpw_etf, day("2026-09-14"), day("2026-09-25"))
    assert len(bars) == 4
    assert all(b.source == "yahoo" and b.instrument_id == gpw_etf.id for b in bars)
    assert [r.url.host for r in requests] == ["stooq.pl", "query1.finance.yahoo.com"]
    assert standard.health["stooq"].blocked is True

    standard.history(gpw_etf, day("2026-09-14"), day("2026-09-25"))
    assert len([r for r in requests if r.url.host == "stooq.pl"]) == 1
