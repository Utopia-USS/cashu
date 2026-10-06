"""The MCP privacy layer, unit by unit: every sensitivity label in both privacy modes, text scrubbing,
the final leak check, fail-closed behaviour for unlabelled values and data-derived keys, and the
person-name guard. Every value is invented."""

from __future__ import annotations

import datetime as dt
import json
import re
from decimal import Decimal

import pytest

from cashu.core.mcp import labels as L
from cashu.core.mcp.names import NameGuard, fold, looks_like_person, normalize
from cashu.core.mcp.redaction import (
    LeakDetected,
    Redactor,
    UnlabelledValue,
    isin_valid,
    leak_check,
    scrub_text,
)

STRICT, AMOUNTS = Redactor("strict"), Redactor("amounts")


# --------------------------------------------------------------------------- #
# Labels x modes
# --------------------------------------------------------------------------- #


def test_identifier_is_dropped_in_both_modes():
    tree = {"iban": L.identifier("PL61109010140000071219812874"), "keep": L.count(1)}
    assert STRICT.apply(tree) == {"keep": 1}
    assert AMOUNTS.apply(tree) == {"keep": 1}


def test_amount_dropped_in_strict_sent_in_amounts():
    tree = {"value": L.amount(Decimal("987654.32")), "weight": L.pct(0.25)}
    assert STRICT.apply(tree) == {"weight": 0.25}
    assert AMOUNTS.apply(tree) == {"value": 987654.32, "weight": 0.25}


def test_amount_in_a_list_is_removed_in_strict():
    tree = {"values": [L.amount(1), L.pct(0.5), L.amount(2)]}
    assert STRICT.apply(tree) == {"values": [0.5]}
    assert AMOUNTS.apply(tree) == {"values": [1, 0.5, 2]}


@pytest.mark.parametrize("redactor", [STRICT, AMOUNTS])
def test_safe_labels_are_sent_and_type_checked(redactor):
    tree = {
        "pct": L.pct(Decimal("0.1234567")),
        "date": L.date(dt.date(2026, 1, 2)),
        "when": L.date(dt.datetime(2026, 1, 2, 3, 4, tzinfo=dt.UTC)),
        "category": L.category("groceries"),
        "symbol": L.symbol("AAPL"),
        "isin": L.symbol("US0378331005"),
        "count": L.count(3),
        "ref": L.ref(17),
        "payee": L.ref("payee:0123456789"),
        "flag": L.flag(True),
        "account": L.account("mBank checking 1"),
        "none": L.text(None),
    }
    assert redactor.apply(tree) == {
        "pct": 0.123457,
        "date": "2026-01-02",
        "when": "2026-01-02T03:04:00+00:00",
        "category": "groceries",
        "symbol": "AAPL",
        "isin": "US0378331005",
        "count": 3,
        "ref": 17,
        "payee": "payee:0123456789",
        "flag": True,
        "account": "mBank checking 1",
        "none": None,
    }


@pytest.mark.parametrize(
    "leaf",
    [
        L.count(1.5),
        L.count(True),
        L.flag(1),
        L.Labelled("10%", L.Sensitivity.PERCENT),
        L.date("yesterday"),
        L.ref("x y"),
    ],
)
def test_wrong_types_fail_closed(leaf):
    with pytest.raises(UnlabelledValue):
        STRICT.apply({"x": leaf})


@pytest.mark.parametrize("raw", [1, 2.5, "text", Decimal(1), True, object()])
def test_unlabelled_leaf_fails_closed(raw):
    with pytest.raises(UnlabelledValue):
        STRICT.apply({"x": raw})
    with pytest.raises(UnlabelledValue):
        AMOUNTS.apply({"nested": [{"x": raw}]})


def test_data_never_becomes_a_key():
    with pytest.raises(UnlabelledValue):
        STRICT.apply({"Konto Jana": L.count(1)})
    with pytest.raises(UnlabelledValue):
        STRICT.apply({"PL61109010140000071219812874": L.count(1)})


def test_text_is_scrubbed_by_mode():
    tree = {"message": L.text("Bucket x is 12.5 pp over (1 234,56 PLN above target).")}
    assert STRICT.apply(tree)["message"] == "Bucket x is 12.5 pp over ([amount] above target)."
    assert AMOUNTS.apply(tree)["message"] == "Bucket x is 12.5 pp over (1 234,56 PLN above target)."


def test_merchant_private_person_becomes_a_ref_in_both_modes():
    guard = NameGuard(
        1, frozenset({"ZOFIA WISNIEWSKA"}), frozenset({"ZOFIA WISNIEWSKA"}), b"k" * 32
    )
    for privacy in ("strict", "amounts"):
        out = Redactor(privacy, guard).apply(
            {"a": L.merchant("ZOFIA WISNIEWSKA"), "b": L.merchant("BIEDRONKA 123")}
        )
        assert out["a"].startswith("payee:") and len(out["a"]) == 16
        assert out["b"] == "BIEDRONKA 123"


# --------------------------------------------------------------------------- #
# Text scrubbing
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "text",
    [
        "PL61109010140000071219812874",
        "PL61 1090 1014 0000 0712 1981 2874",
        "acct 61109010140000071219812874 end",
        "99 1140 0000 0000 0000 0000 0001",
        "card 4111 1111 1111 1111",
        "tel +48 600 700 800",
        "DE89370400440532013000",
        "GB82WEST12345698765432",
    ],
)
@pytest.mark.parametrize("strict", [True, False])
def test_identifiers_are_always_scrubbed(text, strict):
    out = scrub_text(text, strict=strict)
    assert not any(ch.isdigit() for ch in out.replace("+", "")) or "[" in out
    digits = "".join(c for c in out if c.isdigit())
    assert len(digits) < 9, out


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("plan 1500 PLN per month", "plan [amount] per month"),
        ("value 1 234 567,89 zł", "value [amount]"),
        ("worth $1,234.50 now", "worth [amount] now"),
        ("EUR 12.30 fee", "[amount] fee"),
        ("cost 4321.09", "cost [amount]"),
        ("total 98765 in 2026", "total [amount] in 2026"),
        ("37.3% of the portfolio, 2.5 pp drift", "37.3% of the portfolio, 2.5 pp drift"),
        (
            "No deposit for 45 days (last on 2026-01-05)",
            "No deposit for 45 days (last on 2026-01-05)",
        ),
        ("ISIN US0378331005 held", "ISIN US[number] held"),  # free text: no ISIN exemption
        ("rule rebalance_check, row 12", "rule rebalance_check, row 12"),
    ],
)
def test_strict_scrubs_amounts_keeps_percentages_dates_isins(text, expected):
    assert scrub_text(text, strict=True) == expected


def test_amounts_mode_keeps_amounts_but_not_identifiers():
    text = "1500 PLN from PL61109010140000071219812874 (a.b@example.com)"
    assert scrub_text(text, strict=False) == "1500 PLN from [iban] ([email])"


def test_known_names_are_masked_case_and_diacritic_insensitive():
    guard = NameGuard(1, frozenset({"ZOFIA WISNIEWSKA", "KOWALCZYK"}))
    text = "Rozmowa z Zofia Wiśniewska i p. kowalczyk; Kowalczykowa zostaje."
    assert guard.mask(text) == "Rozmowa z [name] i p. [name]; Kowalczykowa zostaje."


def test_isin_check_digit():
    assert isin_valid("US0378331005")
    assert isin_valid("IE00B4L5Y983")
    assert not isin_valid("US0378331006")
    assert not isin_valid("PL61109010140000071219812874")


# --------------------------------------------------------------------------- #
# Leak check
# --------------------------------------------------------------------------- #


def test_leak_check_refuses_identifier_like_values_in_any_mode():
    for strict in (True, False):
        with pytest.raises(LeakDetected):
            leak_check({"note": "PL61109010140000071219812874"}, strict=strict)
        with pytest.raises(LeakDetected):
            leak_check({"rows": ["1234567890123"]}, strict=strict)
    leak_check({"at": "2026-01-02T03:04:05.123456+00:00"}, strict=True)
    with pytest.raises(LeakDetected):  # an ISIN-shaped run only passes when a symbol field sent it
        leak_check({"isin": "US0378331005"}, strict=True)
    leak_check({"isin": "US0378331005"}, strict=True, isins={"US0378331005"})


def test_symbol_fields_carry_isins_and_vat_ids_in_text_are_scrubbed():
    redactor = Redactor("strict")
    out = redactor.apply({"isin": L.symbol("US0378331005"), "note": L.text("NIP PL5260001248")})
    assert out == {"isin": "US0378331005", "note": "NIP PL[number]"}
    leak_check(out, strict=True, isins=redactor.isins)


def test_leak_check_refuses_numbers_under_money_keys_in_strict():
    with pytest.raises(LeakDetected):
        leak_check({"positions": [{"value": 10.0}]}, strict=True)
    leak_check({"positions": [{"value": 10.0}]}, strict=False)
    leak_check({"positions": [{"weight": 0.1}]}, strict=True)


# --------------------------------------------------------------------------- #
# Name guard
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "person"),
    [
        ("ZOFIA WISNIEWSKA", True),
        ("Anna Nowak-Kowalska", True),
        ("J. Z. KOWALSKI", True),
        ("Grzegorz Brzęczyszczykiewicz", True),
        ("WSPOLNOTA MIESZKANIOWA", False),
        ("ABC SP. Z O.O.", False),
        ("NETFLIX.COM", False),
        ("ORLEN STACJA 123", False),
        ("BIEDRONKA", False),
    ],
)
def test_looks_like_person(text, person):
    assert looks_like_person(text) is person


def test_payee_ref_is_stable_and_resolvable():
    guard = NameGuard(7, frozenset(), frozenset({"JAN NOWAK"}), b"s" * 32)
    ref = guard.payee_ref("Jan Nowak")
    assert ref == guard.payee_ref("JAN NOWAK")
    assert guard.resolve(ref, ["BIEDRONKA", "JAN NOWAK"]) == "JAN NOWAK"
    assert guard.resolve("payee:0000000000", ["JAN NOWAK"]) is None
    assert guard.resolve("biedronka", ["BIEDRONKA"]) == "BIEDRONKA"
    other = NameGuard(8, frozenset(), frozenset({"JAN NOWAK"}), b"s" * 32)
    assert other.payee_ref("JAN NOWAK") != ref  # refs are per profile


def test_fold_and_normalize():
    assert fold("Łoś Żółć") == "LOS ZOLC"
    assert normalize("  sp. z o.o.,  ABC ") == "SP Z OO ABC"


# --------------------------------------------------------------------------- #
# Review findings (fixed): symbols, separators, money words, name order / addresses
# --------------------------------------------------------------------------- #


def test_symbol_label_is_scrubbed_for_names_and_amounts():
    guard = NameGuard(1, frozenset({"JAN KOWALSKI", "KOWALSKI"}))
    strict = Redactor("strict", guard)
    out = strict.apply(
        {
            "a": L.symbol("JAN KOWALSKI 15000"),
            "b": L.symbol("KOWALSKI"),
            "c": L.symbol("CDR"),
            "d": L.symbol("0700"),
            "e": L.symbol("123456"),
        }
    )
    assert "KOWALSKI" not in json.dumps(out) and "15000" not in out["a"]
    assert out["c"] == "CDR" and out["d"] == "0700" and out["e"] == "[amount]"


@pytest.mark.parametrize(
    "text",
    [
        "PL61  1090  1014  0000  0712  1981  2874",
        "61.1090.1014.0000.0712.1981.2874",
        "61/1090/1014/0000/0712/1981/2874",
        "PL61_1090_1014_0000_0712_1981_2874",
        "konto U1234567 u brokera",
        "acct 12345678 ok",
        "4111.1111.1111.1111",
    ],
)
@pytest.mark.parametrize("strict", [True, False])
def test_account_numbers_with_other_separators(text, strict):
    out = scrub_text(text, strict=strict)
    assert sum(c.isdigit() for c in out) < 6, out


def test_leak_check_sees_double_spaced_ibans():
    with pytest.raises(LeakDetected):
        leak_check({"note": "PL61  1090  1014  0000  0712  1981  2874"}, strict=False)


@pytest.mark.parametrize(
    "text",
    [
        "850 złotych",
        "999 pln",
        "500 euro",
        "12 tys. zł",
        "100k",
        "kwota 2000",
        "750 RON",
        "1,5 mln",
        "valued at the last known price 950 from x",
        "cash 12.50 left",
    ],
)
def test_strict_money_words(text):
    assert not any(c.isdigit() for c in scrub_text(text, strict=True)), text


@pytest.mark.parametrize("text", ["2026", "in 2026", "since 2019", "2026-09", "2026-Q3", "09/2026"])
def test_years_and_periods_survive(text):
    assert scrub_text(text, strict=True) == text


def test_payee_refs_never_contain_digits():
    guard = NameGuard(1, frozenset(), frozenset({"A B"}), b"x" * 32)
    for i in range(300):
        ref = guard.payee_ref(f"PERSON {i}")
        assert re.fullmatch(r"payee:[a-p]{10}", ref)


def test_names_in_other_order_and_with_an_address():
    guard = NameGuard(1, frozenset({"ANNA NOWAK"}))
    assert guard.is_private("NOWAK ANNA")
    assert guard.mask("przelew dla Nowak Anna") == "przelew dla [name]"
    assert looks_like_person("ANNA NOWAK UL. POLNA 5 WARSZAWA")
    assert looks_like_person("JAN BAR")
    assert not looks_like_person("BAR MLECZNY POD ORLEM")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # the Polish price alert message (alerts/evaluate.py): the close date follows an amount
        (
            "IUSQ: zamknięcie 101,5 EUR (2026-10-01), powyżej 100 EUR.",
            "IUSQ: zamknięcie [amount] (2026-10-01), powyżej [amount].",
        ),
        ("Cena (2026-10-01) wynosi", "Cena (2026-10-01) wynosi"),
        (
            "IUSQ closed at 101.5 EUR on 2026-10-01, above 100 EUR.",
            "IUSQ closed at [amount] on 2026-10-01, above [amount].",
        ),
        # many protected dates (two-digit placeholder indexes) after a money word
        (
            "saldo 12 PLN " + " ".join(f"2025-{m:02d}-01" for m in range(1, 13)),
            "saldo [amount] " + " ".join(f"2025-{m:02d}-01" for m in range(1, 13)),
        ),
    ],
)
def test_a_date_after_an_amount_stays_a_date_and_no_placeholder_leaks(text, expected):
    """F7 re-review B3: the strict scrub never hands NUL / placeholder internals to the agent."""
    out = scrub_text(text, strict=True)
    assert out == expected
    assert "\x00" not in out and not any("" <= ch <= "" for ch in out)
    assert STRICT.apply({"message": L.text(text)})["message"] == expected


def test_stray_nul_characters_never_reach_the_agent():
    assert scrub_text("a\x00b 2026-10-01", strict=True) == "a[date]b 2026-10-01"
