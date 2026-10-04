"""Runs every configured rule against one RuleContext. Pure: no IO, no clock."""

from __future__ import annotations

import logging
from collections.abc import Sequence

from .catalog import RuleCatalog
from .kind import RuleContext, RuleSpec
from .outcomes import NotFired, RuleOutcome, Skipped

_log = logging.getLogger("finanse.investments.rules")


class RulesEngine:
    """Evaluates a strategy's rule specs (usually ``StrategyConfig.rules``)."""

    def __init__(
        self, rules: Sequence[RuleSpec[object]], catalog: RuleCatalog | None = None
    ) -> None:
        self.rules = tuple(rules)
        self._catalog = catalog or RuleCatalog.built_in()

    def evaluate(self, ctx: RuleContext) -> list[RuleOutcome]:
        """Outcomes of every rule, in rule order.

        - An unknown kind, params of the wrong type or a rule that raises yields one whole-rule
          :class:`Skipped` (partial outcomes dropped): one broken rule never aborts the run and never
          resolves its open signals.
        - A rule that returns no outcome at all (nothing to check, e.g. no holdings) yields one whole-rule
          :class:`NotFired`, so its open signals resolve.
        - Outcomes carrying another rule's id are a programming error and turn the rule into Skipped.
        """
        outcomes: list[RuleOutcome] = []
        for spec in self.rules:
            outcomes.extend(self._evaluate_one(ctx, spec))
        return outcomes

    def _evaluate_one(self, ctx: RuleContext, spec: RuleSpec[object]) -> list[RuleOutcome]:
        kind = self._catalog.get(spec.kind)
        if kind is None:
            return [Skipped(spec.id, f'Unknown rule kind "{spec.kind}"')]
        if not isinstance(spec.params, kind.params_type):
            return [
                Skipped(
                    spec.id,
                    f"Rule params have the wrong type ({type(spec.params).__name__}, expected "
                    f"{kind.params_type.__name__})",
                )
            ]
        try:
            outcomes = list(kind.evaluate(ctx, spec))
        except Exception as error:  # noqa: BLE001 - any rule failure becomes a Skipped outcome
            _log.warning("Rule %s (%s) failed", spec.id, spec.kind, exc_info=True)
            return [Skipped(spec.id, f"Rule failed: {type(error).__name__}: {error}")]
        if not outcomes:
            return [NotFired(spec.id, None, {"scopes": 0})]
        foreign = [outcome.rule_id for outcome in outcomes if outcome.rule_id != spec.id]
        if foreign:
            return [Skipped(spec.id, f'Rule returned an outcome for rule "{foreign[0]}"')]
        return outcomes
