"""``custom``: a user-defined condition written in the safe expression language (EXPRESSIONS.md).

Params: ``when`` (the condition, required), ``scope`` (portfolio | instrument | bucket, default portfolio),
optional ``message``; per-instrument filters ``asset_class`` / ``tags`` / ``instrument_ids`` for scope
instrument; ``buckets`` (subset) for scope bucket. Missing or untrustworthy data never fires: the rule
skips that scope with the reasons.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from finanse.modules.investments.domain import is_generic_bucket

from ..expr.catalog import METRICS, Scope, Unit
from ..expr.checker import CompiledExpression, compile_expression
from ..expr.evaluator import Evaluation, Unknown, Value, evaluate
from ..expr.lexer import ExpressionError
from ..expr.metrics import MetricEnv
from ..kind import RuleContext, RuleSpec
from ..outcomes import Fired, NotFired, RuleOutcome, SignalCandidate, Skipped, signal_dedup_key
from ..params import ParamErrors, ParamReader
from ..polarity import SignalPolarity
from .support import (
    NO_ALLOCATIONS,
    InstrumentFilter,
    InstrumentPosition,
    decimal_text,
    format_amount,
    format_decimal,
    format_pct,
    format_pp,
    no_allocation_problem,
    positions_by_instrument,
)

MAX_MESSAGE_LENGTH = 200
CONDITION_MET = "Warunek spełniony"
"""Default message of a fired custom rule without ``message``: ``Warunek spełniony: <when>``."""


@dataclass(frozen=True, slots=True)
class CustomParams:
    expression: CompiledExpression | None
    """None only when parsing failed (the loader then discards the rule)."""
    scope: Scope = Scope.PORTFOLIO
    message: str | None = None
    filter: InstrumentFilter = field(default_factory=InstrumentFilter)
    """Scope instrument only."""
    buckets: tuple[str, ...] = ()
    """Scope bucket only: bucket ids to check; empty = every bucket."""

    @property
    def bucket_references(self) -> tuple[str, ...]:
        """Every bucket id the rule names (``buckets`` plus literals in ``when``), for the loader."""
        refs = list(self.buckets)
        if self.expression is not None:
            refs.extend(bucket for bucket, _ in self.expression.bucket_references)
        return tuple(dict.fromkeys(refs))


class CustomRule:
    """Evaluates ``when`` once per scope: Fired when it is true, NotFired when false, Skipped when the
    answer depends on missing data (Kleene logic, see the evaluator)."""

    KIND = "custom"
    DEFAULT_POLARITY = SignalPolarity.NEUTRAL  # the owner sets polarity per rule

    @property
    def kind(self) -> str:
        return self.KIND

    @property
    def params_type(self) -> type:
        return CustomParams

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> CustomParams:
        reader = ParamReader(raw, errors)
        error_count = errors.error_count
        scope = reader.enum_value("scope", Scope, fallback=Scope.PORTFOLIO)
        scope_ok = errors.error_count == error_count
        when = reader.optional_string("when")
        message = reader.optional_string("message")
        instrument_filter = InstrumentFilter.read(reader)
        buckets = reader.strings("buckets")
        reader.finish()

        expression: CompiledExpression | None = None
        if when is None:
            if not reader.has("when"):
                errors.error("when", 'when is required: a condition such as "weight > 10%"')
        elif scope_ok:
            try:
                expression = compile_expression(when, scope)
            except ExpressionError as error:
                errors.error_at(
                    "when",
                    f"{error.message} (column {error.column} of the expression)",
                    error.column - 1,
                )
        if message is not None:
            if not message.strip():
                errors.error("message", "message must not be empty")
            elif len(message) > MAX_MESSAGE_LENGTH or "\n" in message.strip():
                errors.error(
                    "message",
                    f"message must be one line of at most {MAX_MESSAGE_LENGTH} characters",
                )
        if scope != Scope.INSTRUMENT:
            for key in InstrumentFilter.KEYS:
                if reader.has(key):
                    errors.error(key, f"{key} only applies to scope instrument")
        if scope != Scope.BUCKET and reader.has("buckets"):
            errors.error("buckets", "buckets only applies to scope bucket")
        return CustomParams(
            expression=expression,
            scope=scope,
            message=message.strip() if message else None,
            filter=instrument_filter,
            buckets=buckets,
        )

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[CustomParams]) -> list[RuleOutcome]:
        params = spec.params
        expression = params.expression
        if expression is None:
            return [Skipped(spec.id, "Nie udało się skompilować warunku reguły")]
        match params.scope:
            case Scope.PORTFOLIO:
                env = MetricEnv(ctx)
                return [self._outcome(ctx, spec, env, signal_dedup_key(spec.id), None, {})]
            case Scope.INSTRUMENT:
                return [
                    self._outcome(
                        ctx,
                        spec,
                        MetricEnv(ctx, position=position),
                        signal_dedup_key(spec.id, instrument_id=position.id),
                        position,
                        position.payload(),
                    )
                    for position in positions_by_instrument(ctx, params.filter)
                ]
            case Scope.BUCKET:
                if not ctx.allocations:
                    return [Skipped(spec.id, NO_ALLOCATIONS)]
                bucket_ids = list(params.buckets) or [a.bucket_id for a in ctx.allocations]
                by_id = {allocation.bucket_id: allocation for allocation in ctx.allocations}
                outcomes: list[RuleOutcome] = []
                for bucket_id in bucket_ids:
                    key = signal_dedup_key(spec.id, scope=bucket_id)
                    allocation = by_id.get(bucket_id)
                    if allocation is None:
                        outcomes.append(Skipped(spec.id, no_allocation_problem(bucket_id), key))
                        continue
                    env = MetricEnv(ctx, bucket_id=bucket_id, allocation=allocation)
                    outcomes.append(
                        self._outcome(ctx, spec, env, key, None, {"bucket_id": bucket_id})
                    )
                return outcomes
        raise AssertionError(f"unknown scope {params.scope}")  # pragma: no cover

    def _outcome(
        self,
        ctx: RuleContext,
        spec: RuleSpec[CustomParams],
        env: MetricEnv,
        key: str,
        position: InstrumentPosition | None,
        context_payload: dict[str, object],
    ) -> RuleOutcome:
        params = spec.params
        expression = params.expression
        assert expression is not None
        evaluation = evaluate(expression, env.resolve)
        if evaluation.result is None:
            return Skipped(spec.id, "; ".join(evaluation.reasons), key)
        details: dict[str, object] = {
            **context_payload,
            "scope": params.scope.value,
            "when": expression.normalized,
            "values": _json_values(evaluation),
        }
        if not evaluation.result:
            return NotFired(spec.id, key, details)
        # Owner-facing text never names a non-generic bucket (F7 owner decision; the payload keeps
        # ``when``, ``values`` and ``bucket_id``): no condition text when it names one, no value of a
        # metric naming one, and the ``Koszyk <id>: `` prefix only for a generic bucket (the id: buckets
        # have no display label in the backend).
        private = _private_labels(expression)
        condition = CONDITION_MET if private else f"{CONDITION_MET}: {expression.normalized}"
        text = params.message or condition
        if position is not None:
            text = f"{position.label}: {text}"
        elif env.bucket_id is not None and is_generic_bucket(env.bucket_id):
            text = f"Koszyk {env.bucket_id}: {text}"
        shown = _shown_values(evaluation, str(ctx.portfolio.base_currency), hide=private)
        message = f"{text} ({shown})." if shown else f"{text}."
        return Fired(
            SignalCandidate(
                rule_id=spec.id,
                kind=self.kind,
                dedup_key=key,
                severity=spec.severity,
                instrument_id=position.id if position is not None else None,
                payload=details,
                message=message,
            )
        )


def _unit(label: str) -> Unit:
    return METRICS[label.split("(", 1)[0]].unit


def _json_values(evaluation: Evaluation) -> dict[str, object]:
    result: dict[str, object] = {}
    for label, value in evaluation.values.items():
        result[label] = _json_value(label, value)
    return result


def _json_value(label: str, value: Value) -> object:
    if isinstance(value, Unknown):
        return None
    if isinstance(value, bool | str):
        return value
    assert isinstance(value, Decimal)
    unit = _unit(label)
    if unit in (Unit.RATIO, Unit.PP):
        return float(value)
    if unit in (Unit.DAYS, Unit.COUNT):
        return int(value)
    return decimal_text(value)


def _private_labels(expression: CompiledExpression) -> frozenset[str]:
    """Labels of the metric uses that name a non-generic bucket (``bucket_weight("core")``)."""
    private = {
        (bucket, column)
        for bucket, column in expression.bucket_references
        if not is_generic_bucket(bucket)
    }
    return frozenset(
        ref.label
        for ref in expression.metrics
        if any((arg, ref.column) in private for arg in ref.args if isinstance(arg, str))
    )


def _shown_values(evaluation: Evaluation, currency: str, hide: frozenset[str] = frozenset()) -> str:
    parts: list[str] = []
    for label, value in evaluation.values.items():
        if label not in hide:
            parts.append(f"{label} {_format(label, value, currency)}")
    return ", ".join(parts)


def _format(label: str, value: Value, currency: str) -> str:
    if isinstance(value, Unknown):
        return "nieznane"
    if isinstance(value, bool):
        return "tak" if value else "nie"
    if isinstance(value, str):
        return value
    match _unit(label):
        case Unit.RATIO:
            return format_pct(float(value))
        case Unit.PP:
            return format_pp(float(value))
        case Unit.AMOUNT:
            return f"{format_amount(value)} {currency}"
        case Unit.DAYS | Unit.COUNT:
            return format_amount(value)
        case _:
            return format_decimal(value)
