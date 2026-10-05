"""Signal polarity: every built-in kind declares a default, the engine stamps it on fired candidates,
a rule's ``polarity:`` overrides it, and the strategy loader validates the key."""

from __future__ import annotations

import pytest
from rules_fixtures import context, h, instrument, portfolio

from finanse.modules.investments.rules import (
    BUILT_IN_KINDS,
    Fired,
    NotFired,
    PositionConcentrationParams,
    RuleCatalog,
    RulesEngine,
    RuleSpec,
    SignalPolarity,
    default_polarity,
    polarity_rank,
)
from finanse.modules.investments.strategy import IssueSeverity, load_strategy

EXPECTED = {
    "allocation_drift": SignalPolarity.NEGATIVE,
    "position_concentration": SignalPolarity.NEGATIVE,
    "loss_from_cost": SignalPolarity.NEGATIVE,
    "gain_from_cost": SignalPolarity.POSITIVE,
    "drawdown_from_high": SignalPolarity.POSITIVE,
    "cash_level": SignalPolarity.NEGATIVE,
    "contribution_gap": SignalPolarity.NEGATIVE,
    "tagged_weight": SignalPolarity.NEGATIVE,
    "custom": SignalPolarity.NEUTRAL,
}
PKN, ABC = instrument("PKN"), instrument("ABC")
CTX = context(portfolio_value=portfolio([h(PKN, value="8000"), h(ABC, value="1000")], cash="1000"))


def test_every_built_in_kind_declares_its_default():
    catalog = RuleCatalog.built_in()
    assert set(EXPECTED) == set(BUILT_IN_KINDS)
    for name, polarity in EXPECTED.items():
        assert default_polarity(catalog.get(name)) == polarity, name
    assert default_polarity(object()) == SignalPolarity.NEUTRAL


def concentration(polarity: SignalPolarity | None = None) -> RuleSpec:
    return RuleSpec(
        "concentration",
        "position_concentration",
        PositionConcentrationParams(max_weight=0.5),
        polarity=polarity,
    )


def test_engine_stamps_the_default_and_the_rule_override():
    (pkn, abc) = RulesEngine([concentration()]).evaluate(CTX)
    assert isinstance(pkn, Fired) and pkn.candidate.polarity == SignalPolarity.NEGATIVE
    assert isinstance(abc, NotFired)
    (pkn,) = [
        o
        for o in RulesEngine([concentration(SignalPolarity.POSITIVE)]).evaluate(CTX)
        if isinstance(o, Fired)
    ]
    assert pkn.candidate.polarity == SignalPolarity.POSITIVE


def test_polarity_rank_orders_negative_positive_neutral():
    assert sorted(["neutral", "positive", "negative", "odd"], key=polarity_rank) == [
        "negative",
        "positive",
        "neutral",
        "odd",
    ]


YAML = """\
version: 1
base_currency: PLN
rules:
  - id: big
    kind: position_concentration
    polarity: {polarity}
    params: {{ max_weight: 0.3 }}
  - id: plain
    kind: cash_level
    params: {{ max_weight: 0.2 }}
"""


def test_loader_reads_the_optional_polarity_key():
    result = load_strategy(YAML.format(polarity="positive"))
    assert not [i for i in result.issues if i.severity == IssueSeverity.ERROR], result.issues
    big, plain = result.config.rules
    assert (big.polarity, plain.polarity) == (SignalPolarity.POSITIVE, None)


def test_loader_rejects_an_unknown_polarity_with_a_hint_and_its_line():
    result = load_strategy(YAML.format(polarity="negatve"))
    (issue,) = [i for i in result.issues if i.severity == IssueSeverity.ERROR]
    assert issue.path == "rules[0].polarity" and issue.line == 6
    assert 'Unknown value "negatve" for polarity (did you mean "negative"?)' in issue.message


@pytest.mark.parametrize("value", ["neutral", "negative"])
def test_loader_accepts_every_polarity(value):
    result = load_strategy(YAML.format(polarity=value))
    assert result.config.rules[0].polarity == SignalPolarity(value)
