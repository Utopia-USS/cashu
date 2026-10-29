"""P9 pure parts: ``details.brief`` validation (lengths, forbidden words, supports / risks on macro notes
only, briefs only on segment / macro notes, TTL up to 90 days), the topic-note thesis relation, the
near-duplicate similarity (Polish examples), the ``plain`` sentence of every regime state and the
``full_refresh`` run scope. No IO."""

from __future__ import annotations

import dataclasses
import datetime as dt

import pytest

from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro import texts
from cashu.modules.investments.research import similarity as sim
from cashu.modules.investments.research.validation import (
    BRIEF_HEADLINE_MAX,
    BRIEF_ITEM_MAX,
    BRIEF_WHY_MAX,
    ResearchInputError,
    claim_problem,
    forecast_problem,
    validate_note,
    validate_scope,
)

NOW = dt.datetime(2026, 10, 9, 12, tzinfo=dt.UTC)

TOPIC_BRIEF = {
    "headline": "Rośnie popyt na chipy do centrów danych",
    "why": "Najwięksi klienci zwiększyli wydatki na serwery z AI; producenci chipów raportują "
    "rekordowe zamówienia.",
}
MACRO_BRIEF = {
    "headline": "Trwa hossa na giełdach",
    "why": "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
    "supports": ["Banki centralne obniżają stopy", "Zyski spółek rosną"],
    "risks": ["Wyceny są wysoko", "Wzrosty opierają się na kilku wielkich spółkach"],
}


def raw(**changes) -> dict:
    data = {
        "kind": "trend",
        "polarity": "positive",
        "strength": 2,
        "segment": "semis_ai",
        "title": "Popyt na chipy AI",
        "summary": "Producenci chipów raportują rekordowe zamówienia od operatorów centrów danych.",
        "sources": [
            {
                "url": "https://example.com/p9/1",
                "publisher": "Example News",
                "published_at": "2026-10-07",
            }
        ],
        "details": {"brief": TOPIC_BRIEF},
    }
    data.update(changes)
    return {k: v for k, v in data.items() if v is not None}


def problems(**changes) -> str:
    with pytest.raises(ResearchInputError) as e:
        validate_note(raw(**changes), now=NOW)
    return str(e.value)


def brief(**changes) -> dict:
    return {"details": {"brief": {**TOPIC_BRIEF, **changes}}}


# --------------------------------------------------------------------------- #
# Brief validation
# --------------------------------------------------------------------------- #


def test_a_topic_brief_is_stored_in_details():
    note = validate_note(raw(), now=NOW)
    assert note.details == {"brief": {**TOPIC_BRIEF, "supports": [], "risks": []}}


def test_a_macro_brief_lists_supports_and_risks():
    note = validate_note(
        raw(segment="macro_risk", kind="macro", details={"brief": MACRO_BRIEF}), now=NOW
    )
    assert note.details["brief"] == MACRO_BRIEF


def test_brief_lengths():
    assert "headline: is too short (min 8" in problems(**brief(headline="Hossa"))
    long_headline = "x" * (BRIEF_HEADLINE_MAX + 1)
    assert f"headline: is too long (max {BRIEF_HEADLINE_MAX}" in problems(
        **brief(headline=long_headline)
    )
    assert "why: is required" in problems(**brief(why=None))
    assert f"why: is too long (max {BRIEF_WHY_MAX}" in problems(**brief(why="y" * 281))
    assert validate_note(raw(**brief(headline="x" * BRIEF_HEADLINE_MAX)), now=NOW)
    macro = {"segment": "macro_risk", "kind": "macro"}
    too_many = {**MACRO_BRIEF, "risks": ["Ryzyko jeden", "Ryzyko dwa", "Ryzyko trzy", "Cztery"]}
    assert "at most 3" in problems(**macro, details={"brief": too_many})
    long_item = {**MACRO_BRIEF, "supports": ["s" * (BRIEF_ITEM_MAX + 1)]}
    assert f"supports[0]: is too long (max {BRIEF_ITEM_MAX}" in problems(
        **macro, details={"brief": long_item}
    )
    assert "allowed keys: headline, why, supports, risks" in problems(
        **brief(target="cel")  # an unknown key
    )


@pytest.mark.parametrize(
    "text",
    [
        "Akcje wzrosną jeszcze w tym roku",
        "Kurs spadnie po wynikach spółek",
        "Rynek będzie rósł dalej przez lata",
        "Prognozy analityków są optymistyczne",
        "Kupuj spółki chipowe teraz",
        "Sprzedaj akcje ubezpieczycieli",
        "Analitycy podnieśli cel cenowy spółki",
        "Akcje wzrosna jeszcze w tym roku",
        "Ceny spadna po wynikach",
        "Rynek bedzie rosl dalej",
        "Rynek urośnie w kolejnym roku",
        "Ropa podrożeje zimą",
        "Miedź stanieje po decyzji Chin",
        "Kurs odbije po korekcie",
    ],
)
def test_brief_refuses_forecast_and_call_words(text):
    assert forecast_problem(text)
    assert "reads like a forecast" in problems(**brief(headline=text[:80]))
    assert "reads like a forecast" in problems(**brief(why=text + " i coś jeszcze."))


def test_plain_condition_words_are_fine():
    for text in (
        "Niskie stopy sprzyjają spółkom wzrostowym",
        "Wyceny są wysoko, więc rynek jest wrażliwy na złe wiadomości",
        "Coraz więcej kupujących wraca na rynek gier",
        "Spadły wydatki na reklamę w grach",
    ):
        assert not forecast_problem(text), text


@pytest.mark.parametrize(
    "text",
    [
        "MFW prognozuje wzrost PKB USA o 2,1 % w 2027",
        "Fed w projekcji (dot plot) zakłada stopy 3,4 % na koniec 2026",
        "Według projekcji NBP inflacja spadnie do 2,5 % w 2027",
        "EBC prognozuje inflację w strefie euro na 2,0 % w 2026",
        "IEA szacuje, że popyt na prąd wzrośnie o 4 % rocznie do 2027",
        "OECD przewiduje, że handel światowy urośnie o 2,8 % w 2026",
    ],
)
def test_an_attributed_institutional_trend_forecast_passes(text):
    """Owner decision 2026-10-10: institutions' forecasts of macro / market trends, cited with who,
    how much and horizon, are welcome in a brief (macro and topic) and a note summary."""
    assert not forecast_problem(text), text
    macro = {"segment": "macro_risk", "kind": "macro"}
    note = validate_note(
        raw(
            **macro,
            summary=text + ". Dane z raportu instytucji.",
            details={
                "brief": {
                    **MACRO_BRIEF,
                    "why": text + ".",
                    "supports": [text[:90]],
                    "risks": ["Wyceny są wysoko"],
                }
            },
        ),
        now=NOW,
    )
    assert note.details["brief"]["why"] == text + "."
    assert validate_note(raw(**brief(why=text + ".")), now=NOW)


@pytest.mark.parametrize(
    "text",
    [
        "Prognozujemy, że PKB USA wzrośnie o 2 % w 2027",
        "Analitycy prognozują wzrost zysków spółek o 10 %",
        "Konsensus analityków według MFW prognozuje wzrost PKB o 2 %",
        "S&P 500 wzrośnie do 7000 punktów w 2027",
        "MFW prognozuje, że S&P 500 wzrośnie do 7000 punktów",
        "Fed prognozuje, że wyceny spółek spadną w 2027",
        "Według OECD kurs dolara spadnie do 3,5 zł",
        "MFW prognozuje wzrost PKB. Rynek będzie rósł dalej",
        "Rynek będzie rósł, bo tak prognozuje rynek",
        "Według MFW warto kupić akcje banków",
    ],
)
def test_unattributed_own_analyst_and_price_forecasts_are_still_refused(text):
    assert forecast_problem(text) or claim_problem(text), text
    assert "reads like a forecast" in problems(**brief(why=text + "."))


def test_a_note_summary_may_cite_an_institutional_trend_forecast_but_not_a_price_call():
    ok = "Według projekcji NBP inflacja spadnie do 2,5 % w 2027; RPP utrzymała stopy."
    assert validate_note(raw(summary=ok), now=NOW).summary == ok
    for bad in (
        "Kurs wzrośnie do 50 zł w tym roku po wynikach.",
        "Fed prognozuje, że kurs akcji banków wzrośnie do 50 USD.",
    ):
        assert "notes carry sourced facts" in problems(summary=bad), bad


def test_supports_and_risks_only_on_macro_notes():
    assert "only a macro brief lists supports / risks" in problems(
        **brief(supports=["Niskie stopy sprzyjają"])
    )


def test_a_brief_only_on_segment_or_macro_notes():
    assert "only a segment or macro note carries a brief" in problems(segment=None, kind="news")


def test_brief_notes_may_live_90_days():
    assert validate_note(raw(expires_in_days=90), now=NOW).expires_in_days == 90
    assert "expires_in_days: must be between 1 and 90" in problems(expires_in_days=91)


# --------------------------------------------------------------------------- #
# Topic thesis relation
# --------------------------------------------------------------------------- #


def test_a_topic_note_may_bear_on_its_topic_thesis():
    for relation in ("supports", "weakens", "invalidates"):
        note = validate_note(raw(thesis_relation=relation), now=NOW)
        assert (note.thesis_relation, note.thesis_field) == (relation, "thesis")
    assert validate_note(raw(thesis_relation="weakens", thesis_field="thesis"), now=NOW)
    assert "use thesis" in problems(thesis_relation="weakens", thesis_field="exit_plan")
    assert "a topic note bears on its topic thesis" in problems(thesis_relation="neutral")
    assert "a macro note has no thesis" in problems(
        segment="macro_rates", kind="macro", thesis_relation="supports"
    )


# --------------------------------------------------------------------------- #
# Near duplicates
# --------------------------------------------------------------------------- #


def fp(title: str, summary: str = "", headline: str | None = None) -> sim.Fingerprint:
    return sim.Fingerprint.of(title, summary, headline)


@pytest.mark.parametrize(
    ("old", "new"),
    [
        (
            "Nvidia podnosi prognozę przychodów na kwartał",
            "Nvidia podniosła prognozę przychodów kwartalnych",
        ),
        (
            "Rośnie popyt na chipy do centrów danych",
            "Popyt na chipy do centrów danych dalej rośnie",
        ),
        (
            "UnitedHealth: zabójstwo prezesa wstrząsa branżą",
            "Zabójstwo prezesa UnitedHealth wstrząsnęło branżą ubezpieczeń",
        ),
        ("Wyniki CD Projekt za 3 kwartał", "CD Projekt: wyniki za 3 kwartał"),
    ],
)
def test_the_same_fact_rephrased_is_a_near_duplicate(old, new):
    assert sim.is_near_duplicate(fp(new), fp(old))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("Nvidia podnosi prognozę przychodów", "Nvidia ogłasza skup akcji za 50 mld USD"),
        ("Ludzie grają więcej według nowych badań", "Mniej pieniędzy napływa do branży gier"),
        ("CD Projekt przesuwa premierę gry", "CD Projekt kupuje studio w Kanadzie"),
    ],
)
def test_another_fact_about_the_same_company_is_allowed(old, new):
    assert not sim.is_near_duplicate(fp(new), fp(old))


@pytest.mark.parametrize(
    ("old", "new"),
    [
        # the review's pairs (HIGH-2): a reversal is a new fact
        ("Nvidia podnosi prognozę przychodów", "Nvidia obniża prognozę przychodów"),
        ("Fed obniżył stopy procentowe", "Fed podniósł stopy procentowe"),
        ("Oprocentowanie obligacji w USA rośnie", "Oprocentowanie obligacji w USA spada"),
        ("Popyt na chipy w Azji rośnie", "Popyt na chipy w Azji spada"),
        ("TSMC zwiększa nakłady inwestycyjne", "TSMC zmniejsza nakłady inwestycyjne"),
        ("Rynek chipów w konsolidacji", "Rynek chipów wychodzi z konsolidacji"),
        ("Dolar się umacnia wobec euro", "Dolar słabnie wobec euro"),
        ("Nvidia raises revenue guidance", "Nvidia cuts revenue guidance"),
        # MED-1: numbers stay in the title
        ("Akcje spadły o 10 % od szczytu", "Akcje spadły o 20 % od szczytu"),
        ("Wyniki CD Projekt za 2 kwartał", "Wyniki CD Projekt za 3 kwartał"),
    ],
)
def test_reversals_and_new_numbers_are_never_near_duplicates(old, new):
    assert not sim.is_near_duplicate(fp(new), fp(old))


def test_polarity_or_relation_differs_never_a_near_duplicate():
    title = "Nvidia podnosi prognozę przychodów na kwartał"
    a = sim.Fingerprint.of(title, "", polarity="positive", relation="supports")
    assert sim.is_near_duplicate(
        a, sim.Fingerprint.of(title, "", polarity="positive", relation="supports")
    )
    assert not sim.is_near_duplicate(
        a, sim.Fingerprint.of(title, "", polarity="negative", relation="supports")
    )
    assert not sim.is_near_duplicate(
        a, sim.Fingerprint.of(title, "", polarity="positive", relation="invalidates")
    )


def test_thresholds_are_strict_and_need_four_tokens():
    # 3 of 5 tokens = 0.6 exactly: not above the threshold
    assert (
        sim.jaccard(sim.tokens("alfa beta gamma delta"), sim.tokens("alfa beta gamma epsilon"))
        == 0.6
    )
    assert not sim.is_near_duplicate(fp("alfa beta gamma delta"), fp("alfa beta gamma epsilon"))
    # identical, but fewer than 4 tokens: too little to judge
    assert not sim.is_near_duplicate(fp("Hossa trwa"), fp("Trwa hossa"))


def test_a_new_brief_with_changed_drivers_passes_the_headline_rule():
    old = sim.Fingerprint.of(
        "Zyski spółek z S&P 500 w III kwartale wyżej",
        "Według FactSet zyski spółek wyższe niż rok temu.",
        "Trwa hossa na giełdach światowych",
        why="Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
    )
    same_why = sim.Fingerprint.of(
        "Dane z rynku pracy w USA mocne",
        "Rynek pracy w USA mocny, płace stabilne według BLS.",
        "Hossa na giełdach światowych trwa",
        why="Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
    )
    new_why = sim.Fingerprint.of(
        "Dane z rynku pracy w USA mocne",
        "Rynek pracy w USA mocny, płace stabilne według BLS.",
        "Hossa na giełdach światowych trwa",
        why="Banki centralne obniżają koszt kredytu, a rynek pracy pozostaje mocny.",
    )
    assert sim.is_near_duplicate(same_why, old)
    assert not sim.is_near_duplicate(new_why, old)


def test_body_similarity_catches_a_new_title_on_the_same_text():
    summary = (
        "Według raportu Newzoo gracze spędzają więcej czasu przy grach mobilnych, a liczba "
        "aktywnych graczy w Europie wzrosła rok do roku o kilka procent."
    )
    old = fp("Gracze grają dłużej", summary, "Ludzie grają więcej")
    new = fp("Raport Newzoo o czasie gry", summary + " Dane za trzeci kwartał.")
    assert sim.jaccard(old.title, new.title) < sim.TITLE_MIN
    assert sim.is_near_duplicate(new, old)


def test_tokens_normalize():
    assert sim.tokens("Złoto, ŁÓDŹ i 2025 r.") == frozenset({"zlot", "lodz"})
    assert sim.tokens("Złoto 2025", numbers=True) == frozenset({"zlot", "2025"})
    assert sim.directions("Popyt rośnie, ceny spadły") == frozenset({"up", "down"})
    assert sim.directions("Rynek w konsolidacji") == frozenset()
    assert sim.tokens("prognozę prognozy") == frozenset({"prog"})
    assert sim.tokens(None) == frozenset()
    assert sim.jaccard(frozenset(), frozenset({"a"})) == 0.0


# --------------------------------------------------------------------------- #
# Plain sentences
# --------------------------------------------------------------------------- #


def _regime(key: str, state: str, **changes) -> rg.Regime:
    base = rg.Regime(
        key=key,
        label=rg.LABELS[key],
        state=state,
        state_label=rg.state_label(key, state),
        tone="",
        since=dt.date(2025, 5, 2),
        metrics=(),
        as_of=dt.date(2026, 10, 8),
        stale=False,
        missing=False,
        meaning="",
    )
    return dataclasses.replace(base, **changes)


def test_every_state_has_a_plain_beginner_sentence():
    assert set(texts.PLAIN) == set(rg.STATES)
    for key, states in rg.STATES.items():
        assert set(texts.PLAIN[key]) == set(states), key
        for state in states:
            text = texts.plain(_regime(key, state))
            assert text == texts.PLAIN[key][state]
            assert text.endswith(".") and len(text) <= 120 and "\u2014" not in text
            assert not forecast_problem(text), text
    assert texts.PLAIN["risk"]["bull"].startswith("Trwa hossa")
    assert texts.PLAIN["dollar"]["strong"] == "Dolar się umacnia."


def test_plain_of_an_inverted_curve_and_a_missing_card():
    inverted = texts.plain(_regime("rates", "falling", flags=(rg.INVERTED,)))
    assert inverted == f"{texts.PLAIN['rates']['falling']} {texts.PLAIN_INVERTED}"
    assert texts.plain(_regime("risk", rg.UNKNOWN, missing=True)) == texts.PLAIN_UNKNOWN


# --------------------------------------------------------------------------- #
# full_refresh scope
# --------------------------------------------------------------------------- #


def test_full_refresh_is_never_scheduled():
    with pytest.raises(ResearchInputError, match="never a scheduled run"):
        validate_scope({"full_refresh": True, "scheduled": True})


def test_full_refresh_scope_flag():
    assert validate_scope({"full_refresh": True}).full_refresh is True
    assert validate_scope({}).full_refresh is False
    assert validate_scope({"full_refresh": True}).held is True  # covers everything
    with pytest.raises(ResearchInputError, match="scope.full_refresh"):
        validate_scope({"full_refresh": "yes"})
