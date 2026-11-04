#!/usr/bin/env python3
"""Exact synthetic metric values/reasons from the real Python rules fixtures and resolvers."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "parity/python/oracle/tests/investments/rules"))
from rules_fixtures import AS_OF, alloc, bars, context, d, day, h, instrument, portfolio

from cashu.core.i18n import use_language
from cashu.modules.investments.domain import AssetClass, CashHistoryGap, Currency
from cashu.modules.investments.rules import ContributionPlan, DataQualityPolicy, InstrumentFilter
from cashu.modules.investments.rules.expr import METRICS, MetricRef, Unknown
from cashu.modules.investments.rules.expr.metrics import MetricEnv
from cashu.modules.investments.rules.kinds.support import positions_by_instrument

OUT = ROOT / "packages/domain/test/vectors/inv-rules-metrics.jsonl"
PORTFOLIO = [
    ("total_value", []),
    ("cash_value", []),
    ("cash_weight", []),
    ("stale_weight", []),
    ("unclassified_weight", []),
    ("max_position_weight", []),
    ("holdings_count", []),
    ("days_since_last_deposit", []),
    ("monthly_contribution", []),
    ("bucket_weight", ["equity"]),
    ("bucket_target", ["equity"]),
    ("bucket_drift_pp", ["equity"]),
    ("bucket_value", ["equity"]),
    ("tagged_weight", ["CORE"]),
    ("asset_class_weight", ["etf"]),
    ("asset_class_weight", ["cash"]),
    ("asset_class_weight", ["crypto"]),
    ("bucket_weight", ["private owner name"]),
    ("bucket_weight", ["crypto"]),
]
INSTRUMENT = [
    ("symbol", []),
    ("asset_class", []),
    ("currency", []),
    ("mic", []),
    ("weight", []),
    ("market_value", []),
    ("cost_basis", []),
    ("unrealized_pct", []),
    ("unrealized_value", []),
    ("last_close", []),
    ("drawdown_from_high", [3]),
    ("price_change", [3]),
    ("price_vs_sma", [3]),
    ("holding_has_tag", [" core "]),
]
BUCKET = [
    (name, [])
    for name in ["bucket_id", "weight", "target", "drift_pp", "drift_rel", "value", "drift_value"]
]


def base():
    return {
        "holdings": [
            {
                "symbol": "A",
                "asset": "etf",
                "tags": ["core"],
                "mic": "xetr",
                "value": "100",
                "cost": "80",
            },
            {"symbol": "B", "asset": "equity", "value": "200", "cost": "180"},
            {"symbol": "C", "asset": "cash", "value": "50", "cost": "50"},
        ],
        "cash": "50",
        "deposits": ["2026-09-01", "2026-08-01"],
        "contribution": "125.00",
        "allocations": [
            {"id": "equity", "weight": 0.75, "target": 0.7, "total": 400},
            {"id": "gold", "weight": 0.1, "target": 0.0, "total": 400},
        ],
        "series": [{"symbol": "A", "closes": ["120", "100", "99"]}],
    }


def scenarios():
    yield "good", base()
    p = base()
    p.update(
        holdings=[
            {"symbol": symbol, "asset": "etf", "tags": ["core"], "value": str(n)}
            for n, symbol in enumerate("ABC", 1)
        ],
        cash="4",
        unclassified=[0, 1, 2],
        data={"maxUnclassifiedWeight": 1.0},
    )
    yield "compensated-sum-versus-explicit-loop", p
    for name, changes in [
        ("empty", {"holdings": [], "cash": "0", "series": []}),
        ("no-allocations", {"allocations": []}),
        ("no-contributions", {"deposits": [], "contribution": None}),
        ("future-deposit", {"deposits": ["2026-11-01"]}),
        ("no-series", {"series": []}),
        ("unclassified", {"unclassified": [0, 1]}),
        ("negative-cash-history", {"cashGap": "-50.25"}),
        ("nonfinite-weight", {"weights": ["nan", None, None]}),
    ]:
        p = base()
        p.update(changes)
        yield name, p
    for name, changes in [
        ("unpriced", {"value": None}),
        ("unknown-cost", {"cost": None}),
        ("zero-cost", {"cost": "0"}),
        ("negative-cost", {"cost": "-1"}),
        ("stale", {"stale": True}),
        ("manual", {"manual": True}),
        ("cost-valued", {"atCost": True}),
        ("no-mic", {"mic": None}),
        ("large-money", {"value": "9007199254740993.12", "cost": "9007199254740992.01"}),
    ]:
        p = base()
        p["holdings"][0].update(changes)
        yield name, p
    for mode in [None, "manual", "atCost"]:
        p = base()
        p["holdings"][0].update(currency="USD", value=None, cost=None, stale=True)
        if mode:
            p["holdings"][0][mode] = True
        p["missingFx"] = ["USD"]
        yield f"fx-precedence-{mode}", p
    for name, closes, last in [
        ("stale-before-short-invalid", ["0"], "2026-09-01"),
        ("short-before-invalid", ["0"], None),
        ("invalid-window", ["120", "0", "99"], None),
        ("future-window-clipped", ["120", "100", "99"], "2026-10-04"),
    ]:
        p = base()
        p["series"] = [{"symbol": "A", "closes": closes, **({"last": last} if last else {})}]
        yield name, p
    p = base()
    p["allocations"][0]["gap"] = True
    yield "bucket-cash-gap", p
    p = base()
    p["allocations"][1]["weight"] = 0.0
    yield "zero-target-zero-weight", p
    p = base()
    p["holdings"].insert(
        1, {**p["holdings"][0], "value": "75", "cost": "60", "account": "account-b"}
    )
    yield "multiple-accounts", p
    p = base()
    p["holdings"][0]["tags"] = [" CORE ", "ŻÓŁĆ"]
    yield "tag-normalization", p


def build(p):
    instruments = {}
    specs = []
    for row in p["holdings"]:
        inst = instrument(
            row["symbol"],
            asset_class=AssetClass(row.get("asset", "equity")),
            currency=Currency(row.get("currency", "PLN")),
            tags=tuple(row.get("tags", [])),
            mic=row.get("mic", "XWAR"),
        )
        instruments[row["symbol"]] = inst
        opts = {
            key: row[key] for key in ["value", "cost", "stale", "manual", "account"] if key in row
        }
        if "atCost" in row:
            opts["at_cost"] = row["atCost"]
        specs.append(h(inst, **opts))
    warnings = (
        ()
        if "cashGap" not in p
        else (CashHistoryGap("account-a", Currency.PLN, d(p["cashGap"]), AS_OF),)
    )
    value = portfolio(
        specs,
        cash=p.get("cash", "0"),
        deposits=tuple(day(v) for v in p.get("deposits", [])),
        missing_fx_currencies=frozenset(Currency(v) for v in p.get("missingFx", [])),
        snapshot_warnings=warnings,
    )
    if "weights" in p:
        value = replace(
            value,
            valued=tuple(
                replace(v, weight=float("nan")) if p["weights"][i] == "nan" else v
                for i, v in enumerate(value.valued)
            ),
        )
    allocations = [
        alloc(
            a["id"],
            weight=a["weight"],
            target=a["target"],
            total=a.get("total", 100000),
            cash_history_gap=a.get("gap", False),
        )
        for a in p.get("allocations", [])
    ]
    series = {
        instruments[a["symbol"]]: bars(
            instruments[a["symbol"]], a["closes"], last_date=day(a["last"]) if "last" in a else None
        )
        for a in p.get("series", [])
        if a["symbol"] in instruments
    }
    limits = p.get("data", {})
    return context(
        portfolio_value=value,
        allocations=allocations,
        unclassified=[value.valued[i] for i in p.get("unclassified", [])],
        series=series,
        data=DataQualityPolicy(max_unclassified_weight=limits.get("maxUnclassifiedWeight", 0.02)),
        contributions=ContributionPlan(d(p["contribution"]))
        if p.get("contribution") is not None
        else None,
    )


def encode(value):
    if isinstance(value, Decimal):
        return ["decimal", str(value)]
    if isinstance(value, Unknown):
        return ["unknown", list(value.reasons)]
    return ["boolean" if isinstance(value, bool) else "string", value]


def rows():
    result = []
    covered = set()
    for name, fixture in scenarios():
        ctx = build(fixture)
        positions = positions_by_instrument(ctx, InstrumentFilter(frozenset(AssetClass)))
        selected = next((p for p in positions if p.label == "A"), None)
        queries = [[metric, args, None, None] for metric, args in PORTFOLIO]
        if selected:
            queries += [[metric, args, "A", None] for metric, args in INSTRUMENT]
        for bucket in ["equity", "gold"]:
            queries += [[metric, args, None, bucket] for metric, args in BUCKET]
        for lang in ["pl", "en"]:
            expected = []
            with use_language(lang):
                for metric, args, symbol, bucket in queries:
                    covered.add(metric)
                    allocation = next((a for a in ctx.allocations if a.bucket_id == bucket), None)
                    env = MetricEnv(
                        ctx,
                        position=selected if symbol else None,
                        bucket_id=bucket,
                        allocation=allocation,
                    )
                    expected.append(encode(env.resolve(MetricRef(metric, tuple(args), 1))))
            result.append([name, lang, copy.deepcopy(fixture), queries, expected])
    assert covered == set(METRICS)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    vectors = rows()
    meta = {
        "meta": {
            "name": "inv-rules-metrics",
            "count": len(vectors),
            "layout": "[scenario,lang,syntheticFixture,[[metric,args,symbol|null,bucket|null]],[[kind,value]]]",
            "generator": "parity/python/vectors_inv_rules_metrics.py",
            "python": sys.version.split()[0],
        }
    }
    content = (
        "\n".join(
            json.dumps(row, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
            for row in [meta, *vectors]
        )
        + "\n"
    ).encode("ascii")
    if args.check:
        stale = not OUT.exists() or OUT.read_bytes() != content
        print("stale metric vectors" if stale else "up to date")
        return int(stale)
    OUT.write_bytes(content)
    print(f"{OUT.relative_to(ROOT)} written; {len(vectors)} synthetic contexts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
