"""Bounded invented alert inputs shared by the Python oracle generator, never application code."""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
import sys
from decimal import Decimal
from pathlib import Path

from cashu.core.i18n import use_language
from cashu.modules.investments.alerts import AlertData, AlertDefinition, evaluate_alert
from cashu.modules.investments.alerts.catalog import (
    PRICE_KINDS,
    AlertKind,
    AlertScope,
    AlertValidationError,
    validate,
    validate_tag,
    validate_text,
)
from cashu.modules.investments.domain import Currency, InstrumentStatus, SignalSeverity
from cashu.modules.investments.rules import DataQualityPolicy, SignalPolarity

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parity/python/oracle/tests/investments/rules"))
from rules_fixtures import AS_OF, alloc, bars, context, h, instrument, portfolio


def typed(value):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return {"int": str(value)}
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, list):
        return [typed(item) for item in value]
    if isinstance(value, dict):
        return {key: typed(item) for key, item in value.items()}
    raise TypeError(type(value).__name__)


def jsonable(value):
    if isinstance(value, float) and not math.isfinite(value):
        return {"float": repr(value)}
    if isinstance(value, Decimal):
        return str(value)
    if dataclasses.is_dataclass(value):
        return jsonable(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    return value


def validations():
    cases = []
    valid = {
        "price_above": {"level": 100},
        "price_below": {"level": 100},
        "change_pct": {"window_days": 2, "threshold": 0.1},
        "drawdown_from_high": {"threshold": 0.15},
        "new_high": {},
        "sma_cross": {"direction": "above"},
        "weight_above": {"threshold": 0.2},
        "weight_below": {"threshold": 0.3},
        "custom": {"expression": "weight > 10%"},
        "range_breakout": {},
        "volume_spike": {},
    }
    for kind, params in valid.items():
        inputs = [
            (kind, params, None, True),
            (kind, {**params, "unknown": 1}, None, True),
            (kind, params, None, False),
            (kind, params, "portfolio", True),
            (kind, {**params, "bucket": "own"}, "bucket", False),
        ]
        for key in (
            "level",
            "window_days",
            "threshold",
            "direction",
            "expression",
            "multiple",
            "max_range_pct",
            "bucket",
        ):
            if key in params or key in ("window_days", "multiple", "max_range_pct"):
                for value in (None, True, "bad", -1, 0, 1.0, float("nan"), float("inf")):
                    inputs.append((kind, {**params, key: value}, None, True))
        for name, raw, scope, has_inst in inputs:
            try:
                result = validate(name, raw, scope=scope, has_instrument=has_inst)
                expected = {
                    "kind": result.kind,
                    "scope": result.scope,
                    "params": result.params,
                    "bucketRefs": list(result.bucket_refs),
                }
            except AlertValidationError as error:
                expected = {"issues": error.issues}
            cases.append(
                [
                    typed({"kind": name, "params": raw, "scope": scope, "hasInstrument": has_inst}),
                    jsonable(expected),
                ]
            )
    for raw in (None, [], True, "x"):
        try:
            result = validate("price_above", raw, has_instrument=True)
            expected = {
                "kind": result.kind,
                "scope": result.scope,
                "params": result.params,
                "bucketRefs": list(result.bucket_refs),
            }
        except AlertValidationError as error:
            expected = {"issues": error.issues}
        cases.append(
            [
                typed({"kind": "price_above", "params": raw, "hasInstrument": True}),
                jsonable(expected),
            ]
        )
    for kind in (None, 7, "", "price_abov"):
        try:
            validate(kind, {}, has_instrument=True)
        except AlertValidationError as error:
            cases.append(
                [
                    typed({"kind": kind, "params": {}, "hasInstrument": True}),
                    jsonable({"issues": error.issues}),
                ]
            )
    return cases


def texts():
    out = []
    for title, note in [
        (None, None),
        ("", None),
        ("  Good  ", " note "),
        ("Line\nbreak", None),
        ("😀" * 120, None),
        ("😀" * 121, None),
        ("Good", 2),
        ("Good", "x" * 2001),
        (" Good ", " " * 2001),
        ("\x1cA\x85", None),
    ]:
        try:
            expected = {"value": validate_text(title, note)}
        except AlertValidationError as error:
            expected = {"issues": error.issues}
        out.append([[title, note], jsonable(expected)])
    tags = []
    for tag in [
        None,
        "",
        "  TĄG  12 - ",
        "x" * 24,
        "x" * 25,
        "a!",
        True,
        2,
        "a\x85b",
        "a\x1cb",
        "\ufeffa",
        "العربية",
        "123",
    ]:
        try:
            expected = {"value": validate_tag(tag)}
        except AlertValidationError as error:
            expected = {"issues": error.issues}
        tags.append([tag, jsonable(expected)])
    return out, tags


def evaluations():
    requests = []

    def add(kind, params, closes=(), **extra):
        requests.append({"kind": kind, "params": params, "closes": list(closes), **extra})

    for kind in ("price_above", "price_below"):
        for close in ("99.99", "100", "100.00001", "0", "-1"):
            add(kind, {"level": 100}, [close])
        add(kind, {"level": 1}, [])
        add(kind, {"level": 1}, ["100"], lastDate="2026-09-20")
        add(kind, {"level": 1}, ["100"], lastDate="2026-10-03")
        add(kind, {"level": 1}, ["100"], status="frozen")
        add(kind, {"level": 1}, ["100"], status="delisted")
        add(kind, {"level": 1}, [], noInstrument=True)
    for direction in ("up", "down", "any"):
        for closes in (
            ["100", "103", "112"],
            ["100", "100", "90"],
            ["100", "100", "110"],
            ["100", "100", "100"],
            ["100"],
            ["0", "100", "110"],
        ):
            add("change_pct", {"window_days": 2, "threshold": 0.1, "direction": direction}, closes)
    for closes in (
        ["100", "100", "90"],
        ["100", "100", "91"],
        ["100", "100", "110"],
        ["100", "99", "100"],
    ):
        add("drawdown_from_high", {"window_days": 3, "threshold": 0.1}, closes)
        add("new_high", {"window_days": 3}, closes)
    for direction in ("above", "below"):
        for closes in (
            ["100", "110"],
            ["110", "100"],
            ["100", "100"],
            ["1.000001", "1.000002", "1.000003"],
        ):
            add("sma_cross", {"window_days": len(closes), "direction": direction}, closes)
    for direction in ("any", "up", "down"):
        for last in ("100", "100.000001", "101", "99"):
            add(
                "range_breakout", {"window_days": 10, "direction": direction}, ["100"] * 10 + [last]
            )
    add("range_breakout", {"window_days": 10, "max_range_pct": 0.08}, ["100", "108"] * 5 + ["109"])
    for volumes in (
        [10] * 5 + [25],
        [10] * 5 + [24],
        [0] * 5 + [25],
        [10] * 5 + [None],
        [1, 2, 3, 4, 5, 8],
    ):
        add("volume_spike", {"window_days": 5, "multiple": 2.5}, ["10"] * 6, volumes=volumes)
    for kind in ("weight_above", "weight_below"):
        for threshold in (0.1, 0.2, 0.3):
            add(kind, {"threshold": threshold}, ctx={"held": True, "value": "2000", "cash": "8000"})
        for ctx in (
            {"held": False, "cash": "1000"},
            {"held": True, "value": None, "cash": "1000"},
            {"held": True, "stale": True},
            {"held": True, "manual": True},
            {"held": True, "atCost": True},
            {"held": True, "secondValue": "500", "cash": "1500"},
        ):
            add(kind, {"threshold": 0.3}, ctx=ctx)
        for bucket in ("global_equity", "own"):
            for gap in (False, True):
                add(
                    kind,
                    {"threshold": 0.2, "bucket": bucket},
                    scope="bucket",
                    noInstrument=True,
                    ctx={
                        "cash": "1000",
                        "allocation": {
                            "bucket": bucket,
                            "weight": 0.3,
                            "target": 0.2,
                            "cashHistoryGap": gap,
                        },
                    },
                )
        add(
            kind,
            {"threshold": 0.2, "bucket": "missing"},
            scope="bucket",
            noInstrument=True,
            ctx={"cash": "1000"},
        )
        add(kind, {"threshold": 0.2})
    for scope, params in [
        ("instrument", {"expression": "weight > 10%"}),
        ("portfolio", {"expression": "cash_weight > 5%"}),
        ("bucket", {"expression": "weight > 10%", "bucket": "global_equity"}),
    ]:
        for held in (False, True):
            add(
                "custom",
                params,
                scope=scope,
                noInstrument=scope != "instrument",
                ctx={
                    "held": held,
                    "cash": "1000",
                    "allocation": {"bucket": "global_equity", "weight": 0.3, "target": 0.2},
                },
            )
    add(
        "custom",
        {"expression": "drawdown_from_high(5) > 10%"},
        closes=["100", "100", "100", "100", "70"],
        ctx={"held": True},
    )
    add("unknown_kind", {}, malformed=True)
    for kind, params, closes in [
        (
            "range_breakout",
            {"window_days": 10, "max_range_pct": 0.08, "direction": "any"},
            ["100"] * 10 + ["101"],
        ),
        ("volume_spike", {"window_days": 5, "multiple": 2.5}, ["10"] * 6),
        (
            "change_pct",
            {"window_days": 2, "threshold": 0.1, "direction": "any"},
            ["100", "100", "120"],
        ),
        ("price_above", {"level": 100}, ["110"]),
        ("drawdown_from_high", {"threshold": 0.1, "window_days": 2}, ["120", "110", "100"]),
        ("new_high", {"window_days": 2}, ["100", "100", "110"]),
        ("sma_cross", {"window_days": 2, "direction": "above"}, ["100", "100", "110"]),
        ("weight_above", {"threshold": 0.1}, ["100"]),
        ("weight_below", {"threshold": 0.1}, ["100"]),
        ("custom", {"expression": "weight > 0.1"}, ["100"]),
    ]:
        for key in params:
            for malformedValue in (None, "bad"):
                add(
                    kind,
                    {**params, key: malformedValue},
                    closes,
                    malformedParams=True,
                    **(
                        {"ctx": {"held": True, "value": "2000", "cash": "8000"}}
                        if kind in ("weight_above", "weight_below", "custom")
                        else {}
                    ),
                    **({"volumes": [10] * 5 + [30]} if kind == "volume_spike" else {}),
                )
    for value in ("", "0x10", "0.10", "  .1 ", "1_0", "٠.١", "inf", "-Infinity", "nan", "+NaN"):
        add(
            "weight_above",
            {"threshold": value},
            ["100"],
            malformedParams=True,
            ctx={"held": True, "value": "2000", "cash": "8000"},
        )
        add(
            "volume_spike",
            {"window_days": 5, "multiple": value},
            ["10"] * 6,
            malformedParams=True,
            volumes=[10] * 5 + [30],
        )
    out = []
    for raw in requests:
        for lang in ("pl", "en"):
            request = {**raw, "lang": lang}
            inst = dataclasses.replace(
                instrument("SYN", currency=Currency(raw.get("currency", "PLN"))),
                status=InstrumentStatus(raw.get("status", "active")),
            )
            rows = bars(
                inst,
                raw["closes"],
                last_date=dt.date.fromisoformat(raw.get("lastDate", AS_OF.isoformat())),
            )
            if "volumes" in raw:
                rows = tuple(
                    dataclasses.replace(bar, volume=volume)
                    for bar, volume in zip(rows, raw["volumes"], strict=True)
                )
            ctx = None
            if "ctx" in raw:
                options = raw["ctx"]
                holdings = []
                if options.get("held"):
                    holdings.append(
                        h(
                            inst,
                            **{
                                k: options[k]
                                for k in ("value", "cost", "stale", "manual")
                                if k in options
                            },
                            at_cost=options.get("atCost", False),
                        )
                    )
                if "secondValue" in options:
                    holdings.append(h(inst, value=options["secondValue"], account="account-b"))
                p = portfolio(holdings, cash=options.get("cash", "0"))
                allocations = []
                if "allocation" in options:
                    a = options["allocation"]
                    allocations = [
                        alloc(
                            a["bucket"],
                            weight=a["weight"],
                            target=a["target"],
                            cash_history_gap=a.get("cashHistoryGap", False),
                        )
                    ]
                ctx = context(
                    portfolio_value=p,
                    allocations=allocations,
                    series={inst: rows},
                    data=DataQualityPolicy(),
                )
            if raw.get("malformed"):
                definition = AlertDefinition(
                    "synthetic-alert", raw["kind"], AlertScope.INSTRUMENT, {}, "Synthetic alert"
                )
            elif raw.get("malformedParams"):
                definition = AlertDefinition(
                    "synthetic-alert",
                    AlertKind(raw["kind"]),
                    AlertScope.INSTRUMENT,
                    raw["params"],
                    "Synthetic alert",
                    SignalPolarity.NEGATIVE,
                    SignalSeverity.ACTION,
                    inst,
                )
            else:
                valid = validate(
                    raw["kind"],
                    raw["params"],
                    scope=raw.get("scope"),
                    has_instrument=not raw.get("noInstrument", False) or raw["kind"] in PRICE_KINDS,
                )
                definition = AlertDefinition(
                    "synthetic-alert",
                    AlertKind(valid.kind),
                    AlertScope(valid.scope),
                    valid.params,
                    "Synthetic alert",
                    SignalPolarity.NEGATIVE,
                    SignalSeverity.ACTION,
                    None if raw.get("noInstrument") else inst,
                )
            with use_language(lang):
                result = evaluate_alert(
                    definition, AlertData(AS_OF, {inst.id: rows}, raw.get("maxAge", 5), ctx)
                )
            outcome = result.outcome
            expected = {
                "type": type(outcome).__name__,
                "outcome": jsonable(outcome),
                "value": jsonable(result.value),
            }
            out.append([request, expected])
    return out
