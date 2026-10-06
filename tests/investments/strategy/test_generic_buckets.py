"""Generic buckets (F7-GB GB1): every bucket id the shipped strategy templates use, active or in a
commented example, is in ``GENERIC_BUCKET_IDS``; the match is exact and case-sensitive."""

from __future__ import annotations

import re

import pytest

from cashu.modules.investments.domain import GENERIC_BUCKET_IDS, is_generic_bucket
from cashu.modules.investments.strategy import load_strategy
from cashu.modules.investments.templates import STRATEGY_TEMPLATE_NAMES, strategy_template


def _uncommented(text: str) -> list[str]:
    """Lines with a column-0 ``#`` and one space removed, so commented examples read like YAML."""
    return [re.sub(r"^# ?", "", line) for line in text.splitlines()]


def _example_bucket_ids(text: str) -> set[str]:
    """``- id:`` entries of every ``buckets:`` block (commented or not); rule ids are not included."""
    ids: set[str] = set()
    inside = False
    for line in _uncommented(text):
        if re.match(r"^buckets:\s*$", line):
            inside = True
            continue
        if inside and line and not line[0].isspace():
            inside = False
        if inside and (m := re.match(r"^\s*-\s*id:\s*([A-Za-z0-9_]+)", line)):
            ids.add(m.group(1))
    return ids


def _example_target_ids(text: str) -> set[str]:
    """Keys of every inline ``targets: { id: weight, ... }`` mapping (commented or not)."""
    ids: set[str] = set()
    for block in re.findall(r"targets:\s*\{([^}]*)\}", text):
        ids.update(re.findall(r"([A-Za-z0-9_]+)\s*:", block))
    return ids


@pytest.mark.parametrize("name", STRATEGY_TEMPLATE_NAMES)
def test_every_template_bucket_id_is_generic(name):
    template = strategy_template(name)
    config = load_strategy(template.yaml, template.markdown).config
    assert config is not None
    loaded = {b.id for b in config.allocation.buckets} | set(config.allocation.targets)
    examples = _example_bucket_ids(template.yaml) | _example_target_ids(template.yaml)
    assert loaded | examples, "the template names no bucket at all"
    assert (loaded | examples) <= GENERIC_BUCKET_IDS


def test_the_template_scan_finds_the_known_ids():
    assert _example_bucket_ids(strategy_template("passive_etf").yaml) == {
        "global_equity",
        "bond_etfs",
        "treasury_bonds",
        "cash",
    }
    blank = strategy_template("blank").yaml
    assert _example_bucket_ids(blank) == _example_target_ids(blank) == {"stocks", "bonds", "cash"}


def test_plain_asset_class_ids_are_generic_and_the_match_is_exact():
    for bucket_id in (
        "stocks",
        "equity",
        "equities",
        "bonds",
        "fixed_income",
        "cash",
        "crypto",
        "real_estate",
        "reits",
        "commodities",
        "gold",
    ):
        assert is_generic_bucket(bucket_id), bucket_id
    for bucket_id in ("core", "active", "satellite", "Cash", "STOCKS", " cash", "", None, 1):
        assert not is_generic_bucket(bucket_id), bucket_id
