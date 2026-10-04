"""Shipped strategy templates load without issues; the .md templates are Polish prose; no em dashes."""

from __future__ import annotations

import re
from importlib.resources import files

import pytest

from finanse.modules.investments.domain import SignalSeverity
from finanse.modules.investments.rules import BUILT_IN_KINDS
from finanse.modules.investments.strategy import TOP_LEVEL_KEYS, Weekday, load_strategy
from finanse.modules.investments.templates import (
    STRATEGY_TEMPLATE_NAMES,
    strategy_reference,
    strategy_template,
)

FOLDER = files("finanse.modules.investments.templates").joinpath("strategy")
EM_DASH = chr(0x2014)


def test_every_yaml_template_has_a_md_partner_and_is_listed():
    yaml_names = sorted(
        p.name[: -len(".yaml")] for p in FOLDER.iterdir() if p.name.endswith(".yaml")
    )
    md_names = sorted(
        p.name[: -len(".md")]
        for p in FOLDER.iterdir()
        if p.name.endswith(".md") and p.name != "README.md"
    )
    assert yaml_names == md_names == sorted(STRATEGY_TEMPLATE_NAMES)


@pytest.mark.parametrize("name", STRATEGY_TEMPLATE_NAMES)
def test_template_loads_without_issues(name):
    template = strategy_template(name)
    result = load_strategy(template.yaml, template.markdown)
    assert [str(issue) for issue in result.issues] == []
    assert result.config is not None


def test_passive_etf_is_a_complete_starter():
    config = load_strategy(strategy_template("passive_etf").yaml).config
    assert [b.id for b in config.allocation.buckets] == [
        "global_equity",
        "bond_etfs",
        "treasury_bonds",
        "cash",
    ]
    assert abs(sum(config.allocation.targets.values()) - 1) < 1e-9
    assert [r.kind for r in config.rules] == [
        "allocation_drift",
        "position_concentration",
        "cash_level",
        "drawdown_from_high",
        "contribution_gap",
        "custom",
    ]
    assert config.contributions is not None
    assert config.benchmark is not None and config.benchmark.currency == "PLN"
    assert config.notifications.immediate == {SignalSeverity.ACTION}
    assert config.notifications.digest_weekday == Weekday.SUNDAY


def test_blank_is_valid_with_no_rules_and_no_buckets():
    config = load_strategy(strategy_template("blank").yaml).config
    assert config.rules == ()
    assert config.allocation.buckets == ()
    assert config.benchmark is None


def test_the_commented_examples_in_blank_are_valid_when_uncommented():
    lines = []
    active = False
    for line in strategy_template("blank").yaml.splitlines():
        if line.startswith("rules: []"):
            continue
        match = re.match(r"^# (([a-z_]+):.*)$", line)
        if match and match.group(2) in TOP_LEVEL_KEYS:
            active = True
            lines.append(match.group(1))
        elif active and line.startswith("#   "):
            lines.append(line[2:])
        else:
            active = False
            lines.append(line)
    result = load_strategy("\n".join(lines) + "\n")
    assert result.errors == [], [str(i) for i in result.errors]
    config = result.config
    assert {r.kind for r in config.rules} == {
        "allocation_drift",
        "position_concentration",
        "loss_from_cost",
        "contribution_gap",
        "tagged_weight",
        "custom",
    }
    assert config.benchmark is not None
    assert config.watchlist.max_pe == 20


def test_md_templates_are_polish_prose_with_the_guiding_headings():
    for name in STRATEGY_TEMPLATE_NAMES:
        markdown = strategy_template(name).markdown
        for heading in (
            "## Cel",
            "## Horyzont",
            "## Tolerancja ryzyka",
            "## Zasady wejścia i wyjścia",
            "## Czego unikam",
        ):
            assert heading in markdown, (name, heading)
        assert "Kompas" not in markdown


def test_readme_documents_every_key_and_rule_kind():
    readme = strategy_reference()
    for key in TOP_LEVEL_KEYS:
        assert f"`{key}`" in readme, key
    for kind in BUILT_IN_KINDS:
        assert f"`{kind}`" in readme, kind
    for key in (
        "max_price_age_days",
        "max_stale_weight",
        "max_unclassified_weight",
        "max_fx_age_days",
    ):
        assert f"`{key}`" in readme, key


def test_no_em_dash_anywhere_in_the_templates():
    for path in FOLDER.iterdir():
        assert EM_DASH not in path.read_text(encoding="utf-8"), path.name


def test_unknown_template_name():
    with pytest.raises(KeyError, match="Unknown strategy template"):
        strategy_template("aggressive")
