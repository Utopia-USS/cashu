#!/usr/bin/env python3
"""Synthetic lifecycle differential vectors; no database or data-dir reads."""

from __future__ import annotations

import argparse
import dataclasses
import json
from datetime import datetime, timedelta
from pathlib import Path

from cashu.modules.investments.domain import SignalSeverity, SignalStatus
from cashu.modules.investments.rules import (
    ClosedSignal,
    Fired,
    NotFired,
    OpenSignal,
    RuleSpec,
    SignalCandidate,
    Skipped,
    reconcile_signals,
)
from cashu.modules.investments.rules.polarity import SignalPolarity

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages/domain/test/vectors/inv-rules-lifecycle.jsonl"
FIELDS = {
    "signal_id": "signalId",
    "rule_id": "ruleId",
    "dedup_key": "dedupKey",
    "last_seen_at": "lastSeenAt",
    "created_at": "createdAt",
    "seen_at": "seenAt",
    "previous_severity": "previousSeverity",
    "resolved_at": "resolvedAt",
    "expired_at": "expiredAt",
    "cooldown_until": "cooldownUntil",
    "instrument_id": "instrumentId",
    "account_id": "accountId",
}
TYPES = {
    "CreateSignal": "create",
    "RefreshSignal": "refresh",
    "EscalateSignal": "escalate",
    "ResolveSignal": "resolve",
    "ExpireSignal": "expire",
    "SuppressCandidate": "suppress",
}
NOW = datetime.fromisoformat("2026-10-02T06:00:00.000001+00:00")


def encode(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if dataclasses.is_dataclass(value):
        result = encode(dataclasses.asdict(value))
        if type(value).__name__ in TYPES:
            result = {"type": TYPES[type(value).__name__], **result}
        return result
    if isinstance(value, dict):
        return {FIELDS.get(k, k): encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    return value


def cand(key="r|i:synthetic", severity="info", message="first"):
    return {
        "ruleId": "r",
        "kind": "custom",
        "dedupKey": key,
        "severity": severity,
        "message": message,
        "instrumentId": None,
        "accountId": None,
        "payload": {"synthetic": [True, "value", 3]},
        "polarity": "neutral",
    }


def opened(key="r|i:synthetic", severity="info", status="active", seen=None):
    return {
        "signalId": "signal-" + key,
        "ruleId": "r",
        "dedupKey": key,
        "severity": severity,
        "status": status,
        "lastSeenAt": seen,
    }


def case(name, outcomes=(), opened_rows=(), closed=(), cooldown=7, limit=None, now=NOW, rules=True):
    return [
        name,
        {
            "now": now.isoformat(),
            "outcomes": list(outcomes),
            "open": list(opened_rows),
            "closed": list(closed),
            "rules": [{"id": "r", "cooldownDays": cooldown}] if rules else [],
            "maxDays": limit,
        },
    ]


def cases():
    outcomes = [
        [],
        [{"type": "not_fired", "ruleId": "r", "dedupKey": None}],
        [{"type": "not_fired", "ruleId": "r", "dedupKey": "other"}],
        [{"type": "skipped", "ruleId": "r", "dedupKey": None}],
        [{"type": "skipped", "ruleId": "r", "dedupKey": "r|i:synthetic"}],
        [{"type": "skipped", "ruleId": "r", "dedupKey": "other"}],
        [{"type": "fired", "candidate": cand()}],
        [{"type": "fired", "candidate": cand(severity="action")}],
    ]
    for index, result in enumerate(outcomes):
        for severity in ("info", "action"):
            for status in ("active", "acknowledged"):
                for known in (False, True):
                    yield case(
                        f"precedence-{index}-{severity}-{status}-{known}",
                        result,
                        [opened(severity=severity, status=status)],
                        rules=known,
                    )
    for delta in (-1, 0, 1):
        seen = (NOW - timedelta(days=14, microseconds=delta)).isoformat()
        for result in (outcomes[0], outcomes[3], outcomes[4], outcomes[6], outcomes[1]):
            yield case(f"age-{delta}-{result}", result, [opened(seen=seen)], limit=14)
        closed = [
            {
                "dedupKey": "r|i:synthetic",
                "resolvedAt": (NOW - timedelta(days=7, microseconds=delta)).isoformat(),
            }
        ]
        yield case(f"cooldown-boundary-{delta}", outcomes[6], closed=closed)
    for limit in (None, 0, 14):
        yield case(f"no-seen-{limit}", outcomes[3], [opened()], limit=limit)
        yield case(
            f"old-{limit}", outcomes[3], [opened(seen="2001-01-01T00:00:00+00:00")], limit=limit
        )
    yield case("duplicate-open", opened_rows=[opened(), opened()])
    yield case("naive-seen-aware-now", opened_rows=[opened(seen="2026-09-18T06:00:00")], limit=14)
    yield case(
        "naive-seen-offset-now",
        opened_rows=[opened(seen="2026-09-18T08:00:00")],
        limit=14,
        now=datetime.fromisoformat("2026-10-02T08:00:00.000001+02:00"),
    )
    yield case(
        "aware-offset-seen", opened_rows=[opened(seen="2026-09-18T08:00:00+02:00")], limit=14
    )
    yield case(
        "naive-both",
        opened_rows=[opened(seen="2026-09-18T06:00:00.000001")],
        limit=14,
        now=NOW.replace(tzinfo=None),
    )
    yield case(
        "naive-now-aware-seen",
        opened_rows=[opened(seen="2026-09-18T06:00:00+00:00")],
        limit=14,
        now=NOW.replace(tzinfo=None),
    )
    yield case(
        "newest-close-offsets",
        outcomes[6],
        closed=[
            {"dedupKey": "r|i:synthetic", "resolvedAt": "2026-09-25T09:00:00+03:00"},
            {"dedupKey": "r|i:synthetic", "resolvedAt": "2026-09-25T06:00:00.000002+00:00"},
            {"dedupKey": "r|i:synthetic", "resolvedAt": "2026-09-25T05:00:00-00:30"},
        ],
    )
    for cooldown in (None, 0, -1, 0.5):
        yield case(
            f"cooldown-value-{cooldown}",
            outcomes[6],
            cooldown=cooldown,
            closed=[{"dedupKey": "r|i:synthetic", "resolvedAt": NOW.isoformat()}],
        )
    yield case(
        "severity-tie-and-order",
        [
            {"type": "fired", "candidate": cand()},
            {"type": "fired", "candidate": cand("r|i:second")},
            {"type": "fired", "candidate": cand(severity="action", message="stronger")},
            {"type": "fired", "candidate": cand(severity="action", message="later tie")},
            {"type": "skipped", "ruleId": "r", "dedupKey": None},
        ],
        [opened()],
    )
    yield case(
        "year-1-exact-micros",
        opened_rows=[opened(seen="0001-01-01T00:00:00+00:00")],
        limit=0,
        now=datetime.fromisoformat("0001-01-01T00:00:00.000001+00:00"),
    )
    yield case(
        "max-year-overflow",
        outcomes[6],
        closed=[{"dedupKey": "r|i:synthetic", "resolvedAt": "9999-12-31T23:59:59.999999+00:00"}],
    )


def evaluate(raw):
    open_signals = [
        OpenSignal(
            row["signalId"],
            row["ruleId"],
            row["dedupKey"],
            SignalSeverity(row["severity"]),
            SignalStatus(row["status"]),
            None if row["lastSeenAt"] is None else datetime.fromisoformat(row["lastSeenAt"]),
        )
        for row in raw["open"]
    ]
    outcomes = []
    for row in raw["outcomes"]:
        if row["type"] == "fired":
            c = row["candidate"]
            outcomes.append(
                Fired(
                    SignalCandidate(
                        c["ruleId"],
                        c["kind"],
                        c["dedupKey"],
                        SignalSeverity(c["severity"]),
                        c["message"],
                        payload=c["payload"],
                        polarity=SignalPolarity(c["polarity"]),
                    )
                )
            )
        elif row["type"] == "not_fired":
            outcomes.append(NotFired(row["ruleId"], row["dedupKey"]))
        else:
            outcomes.append(Skipped(row["ruleId"], "synthetic skip", row["dedupKey"]))
    result = reconcile_signals(
        open_signals=open_signals,
        outcomes=outcomes,
        rules=[
            RuleSpec(row["id"], "custom", None, cooldown_days=row["cooldownDays"])
            for row in raw["rules"]
        ],
        clock=lambda: datetime.fromisoformat(raw["now"]),
        closed_signals=[
            ClosedSignal(row["dedupKey"], datetime.fromisoformat(row["resolvedAt"]))
            for row in raw["closed"]
        ],
        max_unverified_days=raw["maxDays"],
    )
    return {
        "actions": [encode(a) for a in result.actions],
        "untouched": [encode(o) for o in result.untouched],
        "stats": result.stats,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rows = []
    for name, raw in cases():
        try:
            expected = evaluate(raw)
        except (ValueError, TypeError, OverflowError) as error:
            expected = {"error": type(error).__name__}
        rows.append([name, raw, expected])
    head = {
        "meta": {
            "name": "inv-rules-lifecycle",
            "count": len(rows),
            "layout": "[name, synthetic input, Python actions/untouched/stats or error]",
        }
    }
    data = (
        "\n".join(json.dumps(r, ensure_ascii=True, separators=(",", ":")) for r in [head, *rows])
        + "\n"
    ).encode()
    if args.check:
        current = OUT.exists() and OUT.read_bytes() == data
        print("up to date" if current else "stale lifecycle vectors")
        return 0 if current else 1
    OUT.write_bytes(data)
    print(f"{len(rows)} synthetic lifecycle vectors written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
