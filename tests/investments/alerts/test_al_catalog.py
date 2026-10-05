"""The alert catalog: every kind validates with defaults filled, scopes are inferred, and every
mistake gets a clear, field-prefixed message (unknown keys are errors with a did-you-mean hint)."""

from __future__ import annotations

import pytest

from finanse.modules.investments.alerts import (
    CATALOG,
    KINDS,
    AlertScope,
    AlertValidationError,
    catalog_dicts,
    validate,
    validate_text,
)


def errors(kind, params, **kw) -> str:
    kw.setdefault("has_instrument", True)
    with pytest.raises(AlertValidationError) as info:
        validate(kind, params, **kw)
    return str(info.value)


@pytest.mark.parametrize(
    ("kind", "params", "has_instrument", "scope", "normalized"),
    [
        ("price_above", {"level": 120}, True, "instrument", {"level": 120.0}),
        ("price_below", {"level": 99.5}, True, "instrument", {"level": 99.5}),
        (
            "change_pct",
            {"window_days": 5, "threshold": 0.1},
            True,
            "instrument",
            {"window_days": 5, "threshold": 0.1, "direction": "any"},
        ),
        (
            "drawdown_from_high",
            {"threshold": 0.2},
            True,
            "instrument",
            {"window_days": 252, "threshold": 0.2},
        ),
        ("new_high", {}, True, "instrument", {"window_days": 252}),
        (
            "sma_cross",
            {"direction": "BELOW"},
            True,
            "instrument",
            {"window_days": 200, "direction": "below"},
        ),
        ("weight_above", {"threshold": 0.3}, True, "instrument", {"threshold": 0.3}),
        (
            "weight_below",
            {"threshold": 0.3, "bucket": " stocks "},
            False,
            "bucket",
            {"threshold": 0.3, "bucket": "stocks"},
        ),
        (
            "custom",
            {"expression": "cash_weight >= 5%"},
            False,
            "portfolio",
            {"expression": "cash_weight >= 5%"},
        ),
        (
            "custom",
            {"expression": "weight > 10%"},
            True,
            "instrument",
            {"expression": "weight > 10%"},
        ),
    ],
)
def test_every_kind_validates_with_defaults(kind, params, has_instrument, scope, normalized):
    valid = validate(kind, params, has_instrument=has_instrument)
    assert valid.scope == AlertScope(scope)
    assert valid.params == normalized


def test_custom_bucket_alert_returns_bucket_references():
    valid = validate(
        "custom",
        {"expression": 'bucket_drift_pp("bonds") <= -3', "bucket": "stocks"},
        has_instrument=False,
    )
    assert valid.scope == AlertScope.BUCKET
    assert valid.bucket_refs == ("stocks", "bonds")


def test_unknown_kind_and_params_have_hints():
    assert 'Unknown alert kind "price_abve" (did you mean "price_above"?)' in errors(
        "price_abve", {}
    )
    message = errors("price_above", {"levle": 1})
    assert "params.level: level is required" in message
    assert 'params.levle: Unknown key "levle" (did you mean "level"?)' in message
    assert "it is ignored" not in message  # an error, not a warning, for alerts
    assert "kind is required" in errors(None, {})
    assert "params must be an object" in errors("price_above", ["x"])


def test_ranges_and_choices():
    assert "window_days must be at least 1 and at most 260, got 0" in errors(
        "change_pct", {"window_days": 0, "threshold": 0.1}
    )
    assert "threshold must be greater than 0" in errors(
        "change_pct", {"window_days": 3, "threshold": 0}
    )
    assert 'Unknown direction "sideways"' in errors(
        "change_pct", {"window_days": 3, "threshold": 0.1, "direction": "sideways"}
    )
    assert "level must be greater than 0" in errors("price_below", {"level": -1})
    assert "level must be a number" in errors("price_below", {"level": "abc"})
    assert "threshold must be" in errors("drawdown_from_high", {"threshold": 1})
    assert "(fractions: 0.15 = 15%)" in errors("weight_above", {"threshold": 30})
    assert "direction is required: above or below" in errors("sma_cross", {})
    assert "window_days must be at least 2" in errors("new_high", {"window_days": 1})


def test_scope_rules():
    assert "price_above alerts need an instrument (add it to the watchlist first" in errors(
        "price_above", {"level": 1}, has_instrument=False
    )
    assert "price_above alerts apply to scope instrument, not bucket" in errors(
        "price_above", {"level": 1}, scope="bucket"
    )
    assert "scope bucket needs params.bucket" in errors(
        "weight_above", {"threshold": 0.2}, scope="bucket", has_instrument=False
    )
    assert "scope portfolio takes no instrument" in errors(
        "custom", {"expression": "cash_weight > 1%"}, scope="portfolio"
    )
    assert "bucket only applies to scope bucket" in errors(
        "weight_above", {"threshold": 0.2, "bucket": "x"}, scope="instrument"
    )
    assert 'Unknown scope "global"' in errors("custom", {"expression": "x"}, scope="global")


def test_custom_expressions_are_compiled_for_the_scope():
    message = errors("custom", {"expression": "weight > "}, has_instrument=False)
    assert message.startswith("params.expression:") and "(column 10 of the expression)" in message
    # an instrument metric in portfolio scope is refused by the compiler
    assert "params.expression" in errors(
        "custom", {"expression": "unrealized_pct < -10%"}, has_instrument=False
    )
    assert "expression is required" in errors("custom", {}, has_instrument=False)


def test_title_and_note():
    assert validate_text("  VWCE below 100 ", " note ") == ("VWCE below 100", "note")
    for bad in ("", "   ", "x" * 121, "two\nlines"):
        with pytest.raises(AlertValidationError):
            validate_text(bad, None)
    with pytest.raises(AlertValidationError, match="note is too long"):
        validate_text("ok", "x" * 2001)


def test_catalog_lists_every_kind_with_params():
    listed = catalog_dicts()
    assert [k["kind"] for k in listed] == list(KINDS) == [k.value for k in CATALOG]
    by_kind = {k["kind"]: k for k in listed}
    assert by_kind["price_above"]["unit"] == "price" and by_kind["change_pct"]["unit"] == "ratio"
    assert {p["name"] for p in by_kind["change_pct"]["params"]} == {
        "window_days",
        "threshold",
        "direction",
    }
    assert by_kind["custom"]["scopes"] == ["instrument", "portfolio", "bucket"]
