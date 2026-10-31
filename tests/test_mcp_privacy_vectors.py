"""Shared synthetic adversarial vectors (S37fix): the same file drives the TypeScript port's test
(``packages/mcp/src/privacy/sharedVectors.test.ts``), so both languages close the same leaks."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cashu.core.mcp import labels as L
from cashu.core.mcp.names import NameGuard
from cashu.core.mcp.redaction import (
    LeakDetected,
    Redactor,
    UnlabelledValue,
    leak_check,
    scrub_text,
)

VECTORS = json.loads((Path(__file__).parent / "mcp_privacy_vectors.json").read_text("utf-8"))
GUARD = NameGuard(1, frozenset(VECTORS["guard_names"]))


def _case_id(v: dict) -> str:
    return f"{v['finding']}:{v.get('note') or v['text']!r}"


@pytest.mark.parametrize("vector", VECTORS["texts"], ids=_case_id)
def test_text_vectors(vector):
    for mode in vector["modes"]:
        redactor = Redactor(mode, GUARD if vector.get("guard") else None)
        out = redactor.apply({"note": L.text(vector["text"])})
        sent = out["note"]
        for secret in vector["absent"]:
            assert secret not in sent, (mode, sent)
        if "expect" in vector:
            assert sent == vector["expect"][mode]
        leak_check(out, strict=redactor.strict, isins=redactor.isins, non_money=redactor.non_money)


@pytest.mark.parametrize("vector", VECTORS["symbols"], ids=lambda v: v["symbol"])
def test_symbol_vectors(vector):
    for mode in ("strict", "amounts"):
        redactor = Redactor(mode)
        out = redactor.apply({"symbol": L.symbol(vector["symbol"])})
        if mode == "strict":
            for secret in vector.get("strict_absent", []):
                assert secret not in out["symbol"]
        if "expect" in vector:
            assert out["symbol"] == vector["expect"][mode]
        leak_check(out, strict=redactor.strict, isins=redactor.isins)


@pytest.mark.parametrize("vector", VECTORS["dates_refused"], ids=lambda v: v["date"])
def test_date_label_refuses_digit_runs(vector):
    for mode in ("strict", "amounts"):
        with pytest.raises(UnlabelledValue):
            Redactor(mode).apply({"at": L.date(vector["date"])})


@pytest.mark.parametrize("value", VECTORS["dates_kept"])
def test_date_label_keeps_iso_forms(value):
    assert Redactor("strict").apply({"at": L.date(value)}) == {"at": value}


@pytest.mark.parametrize("vector", VECTORS["leaks"], ids=lambda v: json.dumps(v["tree"]))
def test_leak_check_vectors(vector):
    if vector["leak"]:
        with pytest.raises(LeakDetected):
            leak_check(vector["tree"], strict=vector["strict"])
    else:
        leak_check(vector["tree"], strict=vector["strict"])


def test_scrub_keeps_the_original_text_outside_masked_spans():
    text = "Za obiad - karta 4532 0151 1283 0366,\tdzięki!"
    assert scrub_text(text, strict=False) == "Za obiad - karta [number],\tdzięki!"


@pytest.mark.parametrize(
    "vector", VECTORS["authored"], ids=lambda v: f"{v['finding']}:{v['text']!r}"
)
def test_authored_text_keeps_numbers_but_not_identifiers(vector):
    # S37fix R3: cashU's own constant text is not owner data
    for mode, expected in vector["expect"].items():
        redactor = Redactor(mode, GUARD)
        out = redactor.apply({"f": L.fixed_text(vector["text"])})
        assert out == {"f": expected}
        leak_check(out, strict=redactor.strict, isins=redactor.isins)
    if "owner_strict" in vector:
        owner = Redactor("strict", GUARD).apply({"t": L.text(vector["text"])})
        assert owner == {"t": vector["owner_strict"]}


@pytest.mark.parametrize("vector", VECTORS["symbols_known"], ids=lambda v: v["symbol"])
def test_known_digit_only_symbols_stay(vector):
    # S37fix R5: the guard carries the profile's digit-only tickers
    guard = NameGuard(
        1, frozenset(VECTORS["guard_names"]), symbols=frozenset(VECTORS["known_symbols"])
    )
    for mode, expected in vector["expect"].items():
        assert Redactor(mode, guard).apply({"s": L.symbol(vector["symbol"])}) == {"s": expected}
