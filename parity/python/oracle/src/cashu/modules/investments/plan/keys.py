"""Identity of plan-check signals (stdlib only, so the daily check and the views can use it without
loading the checks).

A plan-check signal has ``rule_id = kind = "plan:<check>"`` (``plan:plan_no_exit``,
``plan:plan_vs_thesis``) and ``dedup_key = "plan:<check>|i:<instrument id>"`` (one open signal per
check and instrument). Strategy rule ids cannot contain ``:``, so the prefix never clashes.
"""

from __future__ import annotations

PLAN_PREFIX = "plan:"


def is_plan_key(value: str | None) -> bool:
    """True for the rule id / dedup key / kind of a plan-check signal."""
    return bool(value) and value.startswith(PLAN_PREFIX)


def plan_rule_id(check: str) -> str:
    return f"{PLAN_PREFIX}{check}"


def plan_dedup_key(check: str, instrument_id: int | str) -> str:
    """``plan:plan_no_exit|i:12``."""
    return f"{PLAN_PREFIX}{check}|i:{instrument_id}"
