"""Parses and validates strategy.yaml into a StrategyConfig, reporting every problem with its YAML path,
line and column. Pure: no IO (the caller reads the files)."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from yaml.nodes import MappingNode, Node, SequenceNode

from finanse.modules.investments.domain import (
    AllocationPlan,
    AssetClass,
    BucketDef,
    BucketMatch,
    Currency,
    SignalSeverity,
)
from finanse.modules.investments.rules import (
    AllocationDriftParams,
    AllocationDriftRule,
    ContributionGapRule,
    ContributionPlan,
    CustomParams,
    DataQualityPolicy,
    ParamErrors,
    ParamIssue,
    ParamReader,
    RebalancePolicy,
    RuleCatalog,
    RuleSpec,
    did_you_mean,
)
from finanse.modules.investments.rules.expr import Scope
from finanse.modules.investments.rules.params import parse_currency

from . import yaml_tree
from .config import Benchmark, NotificationPolicy, StrategyConfig, WatchlistCriteria, Weekday
from .issues import InactiveRule, IssueSeverity, StrategyIssue, StrategyLoadResult

TOP_LEVEL_KEYS = (
    "version",
    "base_currency",
    "horizon_years",
    "contributions",
    "data",
    "buckets",
    "allocation",
    "rules",
    "watchlist",
    "benchmark",
    "notifications",
)
"""Top-level keys of strategy.yaml, in documentation order."""

SUPPORTED_VERSIONS = (1,)
TARGET_SUM_TOLERANCE = 0.001
"""Allowed deviation of the ``allocation.targets`` sum from 1."""

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
_RULE_PATH = re.compile(r"^rules\[(\d+)\]")
_ID_RULE = 'may only contain letters, digits, "_", "." and "-"'


class StrategyLoader:
    """Loads strategy.yaml (+ optional strategy.md) of one profile.

    Validation: ``version`` (supported: 1) and ``base_currency`` are required; ``allocation.targets``
    must reference defined buckets and sum to 1 (+-0.001); rule ids are unique, kinds come from the
    catalog and each kind validates its params (``custom`` compiles its expression); unknown keys
    anywhere are warnings with a closest-known-key hint. YAML syntax errors, duplicate keys, anchors /
    aliases, merge keys and custom tags are errors with the parser's location.
    """

    def __init__(self, catalog: RuleCatalog | None = None) -> None:
        self._catalog = catalog or RuleCatalog.built_in()

    def load(self, yaml_text: str, md: str | None = None) -> StrategyLoadResult:
        """Parses ``yaml_text``; ``md`` (strategy.md) is kept on the config and only checked for being
        non-empty."""
        return _Parse(self._catalog, yaml_text, md).run()


def load_strategy(
    yaml_text: str, md: str | None = None, catalog: RuleCatalog | None = None
) -> StrategyLoadResult:
    """Shortcut for ``StrategyLoader(catalog).load(yaml_text, md)``."""
    return StrategyLoader(catalog).load(yaml_text, md)


@dataclass(frozen=True, slots=True)
class _Header:
    version: int
    base_currency: Currency
    horizon_years: int | None


@dataclass(frozen=True, slots=True)
class _BucketEntry:
    definition: BucketDef
    node: MappingNode
    index: int


@dataclass(frozen=True, slots=True)
class _Allocation:
    targets: dict[str, float]
    rebalance: RebalancePolicy
    rebalance_node: MappingNode | None


class _Parse:
    """One-shot parse state."""

    def __init__(self, catalog: RuleCatalog, source: str, md: str | None) -> None:
        self._catalog = catalog
        self._source = source
        self._md = md
        self._issues: list[StrategyIssue] = []

    def run(self) -> StrategyLoadResult:
        try:
            root = yaml_tree.compose(self._source)
        except yaml_tree.YamlTreeError as error:
            self._issues.append(
                StrategyIssue(IssueSeverity.ERROR, "", error.message, error.line, error.column)
            )
            return StrategyLoadResult(None, tuple(self._issues))
        if not isinstance(root, MappingNode):
            if root is None or yaml_tree.is_absent(root):
                message = "strategy.yaml is empty; it needs at least version and base_currency"
                self._issues.append(StrategyIssue(IssueSeverity.ERROR, "", message, 1, 1))
            else:
                message = "strategy.yaml must be a mapping of keys (version, base_currency, ...)"
                self._error("", root, message)
            return StrategyLoadResult(None, tuple(self._issues))

        header = self._header(root)
        data = self._section(root, "data", _read_data) or DataQualityPolicy()
        contributions = self._section(root, "contributions", _read_contributions)
        buckets = self._buckets(root)
        allocation = self._allocation(root, buckets)
        rules = self._rules(
            root,
            bucket_ids=[bucket.definition.id for bucket in buckets],
            has_targets=bool(allocation.targets),
            rebalance=allocation.rebalance,
            rebalance_node=allocation.rebalance_node,
            has_contributions=not yaml_tree.is_absent(yaml_tree.get(root, "contributions")),
        )
        watchlist = self._watchlist(root)
        benchmark = self._section(root, "benchmark", lambda reader: _read_benchmark(reader, header))
        notifications = (
            self._section(root, "notifications", _read_notifications) or NotificationPolicy()
        )
        if self._md is not None and not self._md.strip():
            self._issues.append(
                StrategyIssue(
                    IssueSeverity.WARNING,
                    "strategy.md",
                    "strategy.md is empty; write down your goals so later reports have context",
                )
            )

        def config() -> StrategyConfig:
            assert header is not None
            return StrategyConfig(
                version=header.version,
                base_currency=header.base_currency,
                horizon_years=header.horizon_years,
                allocation=AllocationPlan(
                    buckets=tuple(bucket.definition for bucket in buckets),
                    targets=allocation.targets,
                ),
                rebalance=allocation.rebalance,
                data=data,
                contributions=contributions,
                rules=tuple(rules),
                watchlist=watchlist,
                benchmark=benchmark if isinstance(benchmark, Benchmark) else None,
                notifications=notifications,
                markdown=self._md,
            )

        errors = [issue for issue in self._issues if issue.is_error]
        inactive = self._inactive_rules(root, errors)
        if header is None or errors:
            only_rules = header is not None and all(_RULE_PATH.match(e.path) for e in errors)
            return StrategyLoadResult(
                None,
                tuple(self._issues),
                partial=config() if only_rules else None,
                inactive_rules=inactive,
            )
        return StrategyLoadResult(config(), tuple(self._issues))

    def _inactive_rules(
        self, root: MappingNode, errors: list[StrategyIssue]
    ) -> tuple[InactiveRule, ...]:
        """Rule entries with errors of their own (``rules[i]...`` paths), in file order."""
        by_index: dict[int, list[StrategyIssue]] = {}
        for issue in errors:
            match = _RULE_PATH.match(issue.path)
            if match:
                by_index.setdefault(int(match.group(1)), []).append(issue)
        node = yaml_tree.get(root, "rules")
        items = node.value if isinstance(node, SequenceNode) else []
        out: list[InactiveRule] = []
        for index in sorted(by_index):
            item = items[index] if index < len(items) else None
            raw = yaml_tree.plain_map(item) if isinstance(item, MappingNode) else {}
            rule_id, kind = raw.get("id"), raw.get("kind")
            out.append(
                InactiveRule(
                    index=index,
                    rule_id=rule_id if isinstance(rule_id, str) else None,
                    kind=kind if isinstance(kind, str) else None,
                    line=yaml_tree.position(item)[0] if item is not None else None,
                    issues=tuple(by_index[index]),
                )
            )
        return tuple(out)

    # --- sections ------------------------------------------------------------------------------

    def _header(self, root: MappingNode) -> _Header | None:
        errors = ParamErrors()
        raw = yaml_tree.plain_map(root)
        reader = ParamReader(raw, errors)
        version = reader.integer("version")
        currency_code = reader.optional_string("base_currency")
        horizon_years = reader.optional_integer("horizon_years", minimum=1, maximum=100)
        reader.finish(also_known=TOP_LEVEL_KEYS)

        raw_version = raw.get("version")
        is_integer = isinstance(raw_version, int) and not isinstance(raw_version, bool)
        if is_integer and version not in SUPPORTED_VERSIONS:
            supported = ", ".join(str(v) for v in SUPPORTED_VERSIONS)
            errors.error("version", f"Unsupported version {version} (supported: {supported})")
        base_currency: Currency | None = None
        if currency_code is None:
            if not reader.has("base_currency"):
                errors.error("base_currency", "base_currency is required (e.g. PLN)")
        else:
            base_currency = parse_currency(currency_code)
            if base_currency is None:
                errors.error(
                    "base_currency", f'"{currency_code}" is not a three-letter ISO currency code'
                )
            elif base_currency != Currency.PLN:
                errors.warning(
                    "base_currency",
                    "Only PLN is fully supported as base currency (FX rates come from NBP in PLN)",
                )
        self._report(errors.issues, root, "")
        if errors.has_errors or base_currency is None:
            return None
        return _Header(version, base_currency, horizon_years)

    def _buckets(self, root: MappingNode) -> list[_BucketEntry]:
        node = yaml_tree.get(root, "buckets")
        if yaml_tree.is_absent(node):
            return []
        assert node is not None
        if not isinstance(node, SequenceNode):
            self._error("buckets", node, "buckets must be a list of {id, match} entries")
            return []
        found: list[_BucketEntry] = []
        first_line: dict[str, int] = {}
        for index, item in enumerate(node.value):
            path = f"buckets[{index}]"
            if not isinstance(item, MappingNode):
                self._error(path, item, "Each bucket must be a mapping with id and match")
                continue
            errors = ParamErrors()
            reader = ParamReader(yaml_tree.plain_map(item), errors)
            bucket_id = reader.optional_string("id")
            reader.has("match")
            reader.finish()
            if bucket_id is None:
                if not reader.has("id"):
                    errors.error("id", "Bucket id is required")
            elif not _ID_PATTERN.match(bucket_id):
                errors.error("id", f'Bucket id "{bucket_id}" {_ID_RULE}')
            elif bucket_id in first_line:
                errors.error(
                    "id",
                    f'Duplicate bucket id "{bucket_id}" (first defined on line {first_line[bucket_id]})',
                )
            else:
                first_line[bucket_id] = yaml_tree.position(item)[0]
            self._report(errors.issues, item, path)

            match: BucketMatch | None = None
            if yaml_tree.is_absent(yaml_tree.get(item, "match")):
                self._error(
                    f"{path}.match",
                    item,
                    "match is required (use match: {} for a catch-all bucket)",
                )
            else:
                match = self._section(item, "match", _read_match, parent_path=path)
            if not errors.has_errors and bucket_id is not None and match is not None:
                found.append(_BucketEntry(BucketDef(bucket_id, match), item, index))

        for entry in found[:-1]:
            if entry.definition.match.is_empty:
                self._warning(
                    f"buckets[{entry.index}].match",
                    entry.node,
                    f'Bucket "{entry.definition.id}" matches every instrument, so the buckets after it '
                    "never match",
                )
        takes_cash = any(
            entry.definition.match.is_empty
            or AssetClass.CASH in entry.definition.match.asset_classes
            for entry in found
        )
        if found and not takes_cash:
            self._warning(
                "buckets",
                node,
                "No bucket matches asset_class: cash, so cash balances stay unallocated",
            )
        return found

    def _allocation(self, root: MappingNode, buckets: list[_BucketEntry]) -> _Allocation:
        node = yaml_tree.get(root, "allocation")
        if yaml_tree.is_absent(node):
            if buckets:
                buckets_node = yaml_tree.get(root, "buckets")
                assert buckets_node is not None
                self._warning(
                    "buckets", buckets_node, "Buckets are defined but allocation.targets is missing"
                )
            return _Allocation({}, RebalancePolicy(), None)
        assert node is not None
        if not isinstance(node, MappingNode):
            self._error(
                "allocation", node, "allocation must be a mapping with targets and rebalance"
            )
            return _Allocation({}, RebalancePolicy(), None)
        self._check_keys(node, "allocation", ("targets", "rebalance"))

        rebalance = (
            self._section(node, "rebalance", RebalancePolicy.read, parent_path="allocation")
            or RebalancePolicy()
        )
        rebalance_yaml = yaml_tree.get(node, "rebalance")
        rebalance_node = rebalance_yaml if isinstance(rebalance_yaml, MappingNode) else None

        targets_node = yaml_tree.get(node, "targets")
        if yaml_tree.is_absent(targets_node):
            self._error(
                "allocation.targets",
                node,
                "allocation.targets is required (bucket id -> weight, summing to 1)",
            )
            return _Allocation({}, rebalance, rebalance_node)
        assert targets_node is not None
        if not isinstance(targets_node, MappingNode):
            self._error(
                "allocation.targets",
                targets_node,
                "allocation.targets must be a mapping of bucket id -> weight",
            )
            return _Allocation({}, rebalance, rebalance_node)

        bucket_ids = [bucket.definition.id for bucket in buckets]
        targets: dict[str, float] = {}
        all_valid = True
        for entry in yaml_tree.entries(targets_node):
            bucket_id = entry.key
            path = f"allocation.targets.{bucket_id}"
            value = yaml_tree.to_plain(entry.value)
            if bucket_id not in bucket_ids:
                all_valid = False
                if bucket_ids:
                    message = f'Target references undefined bucket "{bucket_id}"{did_you_mean(bucket_id, bucket_ids)}'
                else:
                    message = (
                        f'Target references undefined bucket "{bucket_id}" (no buckets are defined)'
                    )
                self._error(path, entry.key_node, message)
                continue
            if not isinstance(value, int | float) or isinstance(value, bool) or not 0 <= value <= 1:
                all_valid = False
                self._error(
                    path,
                    entry.value,
                    f"Target of {bucket_id} must be a number between 0 and 1 (0.6 = 60%), got {value}",
                )
                continue
            targets[bucket_id] = float(value)
        if all_valid:
            total = sum(targets.values())
            if abs(total - 1) > TARGET_SUM_TOLERANCE:
                self._error(
                    "allocation.targets",
                    targets_node,
                    f"Targets sum to {total:.3f}, expected 1 (+-{TARGET_SUM_TOLERANCE})",
                )
        for bucket in buckets:
            if bucket.definition.id in targets:
                continue
            self._warning(
                "allocation.targets",
                targets_node,
                f'Bucket "{bucket.definition.id}" has no target in allocation.targets; it is treated as 0',
            )
            targets[bucket.definition.id] = 0.0
        return _Allocation(targets, rebalance, rebalance_node)

    def _rules(
        self,
        root: MappingNode,
        *,
        bucket_ids: list[str],
        has_targets: bool,
        rebalance: RebalancePolicy,
        rebalance_node: MappingNode | None,
        has_contributions: bool,
    ) -> list[RuleSpec[object]]:
        node = yaml_tree.get(root, "rules")
        specs: list[RuleSpec[object]] = []
        has_drift_rule = False
        if not yaml_tree.is_absent(node) and not isinstance(node, SequenceNode):
            assert node is not None
            self._error("rules", node, "rules must be a list of {id, kind, params} entries")
        elif isinstance(node, SequenceNode):
            first_line: dict[str, int] = {}
            known_kinds = list(self._catalog.kinds)
            for index, item in enumerate(node.value):
                path = f"rules[{index}]"
                if not isinstance(item, MappingNode):
                    self._error(
                        path, item, "Each rule must be a mapping with id, kind and optional params"
                    )
                    continue
                error_count = self._error_count
                errors = ParamErrors()
                reader = ParamReader(yaml_tree.plain_map(item), errors)
                rule_id = reader.optional_string("id")
                kind_name = reader.optional_string("kind")
                severity = reader.enum_value(
                    "severity", SignalSeverity, fallback=SignalSeverity.INFO
                )
                cooldown_days = reader.optional_integer("cooldown_days", minimum=0)
                reader.has("params")
                reader.finish()
                if rule_id is None:
                    if not reader.has("id"):
                        errors.error("id", "Rule id is required")
                elif not _ID_PATTERN.match(rule_id):
                    errors.error("id", f'Rule id "{rule_id}" {_ID_RULE}')
                elif rule_id in first_line:
                    errors.error(
                        "id",
                        f'Duplicate rule id "{rule_id}" (first defined on line {first_line[rule_id]})',
                    )
                else:
                    first_line[rule_id] = yaml_tree.position(item)[0]
                kind = self._catalog.get(kind_name) if kind_name is not None else None
                if kind_name is None:
                    if not reader.has("kind"):
                        errors.error(
                            "kind", f"Rule kind is required; known: {', '.join(known_kinds)}"
                        )
                elif kind is None:
                    errors.error(
                        "kind",
                        f'Unknown rule kind "{kind_name}"{did_you_mean(kind_name, known_kinds)}; '
                        f"known: {', '.join(known_kinds)}",
                    )
                self._report(errors.issues, item, path)

                params_node = yaml_tree.get(item, "params")
                raw: dict[str, object] = {}
                if not yaml_tree.is_absent(params_node):
                    assert params_node is not None
                    if not isinstance(params_node, MappingNode):
                        self._error(f"{path}.params", params_node, "params must be a mapping")
                        continue
                    raw = yaml_tree.plain_map(params_node)
                if kind is None:
                    continue
                if kind.kind == AllocationDriftRule.KIND:
                    has_drift_rule = True
                    raw = {**rebalance.to_raw(), **raw}
                param_errors = ParamErrors()
                params = kind.parse_params(raw, param_errors)
                spec: RuleSpec[object] = RuleSpec(
                    id=rule_id or "",
                    kind=kind.kind,
                    params=params,
                    severity=severity,
                    cooldown_days=cooldown_days,
                )
                base = params_node if isinstance(params_node, MappingNode) else item
                self._report(param_errors.issues, base, f"{path}.params")
                if not param_errors.has_errors:
                    self._cross_check(
                        spec,
                        item,
                        path,
                        bucket_ids=bucket_ids,
                        has_targets=has_targets,
                        has_contributions=has_contributions,
                    )
                if self._error_count == error_count:
                    specs.append(spec)
        if rebalance_node is not None and not has_drift_rule:
            self._warning(
                "allocation.rebalance",
                rebalance_node,
                "Rebalance bands are only checked by an allocation_drift rule; add one to rules",
            )
        return specs

    def _cross_check(
        self,
        spec: RuleSpec[object],
        node: MappingNode,
        path: str,
        *,
        bucket_ids: list[str],
        has_targets: bool,
        has_contributions: bool,
    ) -> None:
        params = spec.params
        params_node = yaml_tree.get(node, "params")
        params_map = params_node if isinstance(params_node, MappingNode) else None
        if isinstance(params, AllocationDriftParams):
            if not has_targets:
                self._error(path, node, "allocation_drift needs buckets and allocation.targets")
            self._check_bucket_list(params.buckets, params_map, node, path, bucket_ids)
        if isinstance(params, CustomParams):
            if params.scope == Scope.BUCKET and not has_targets:
                self._error(
                    path, node, "custom rules with scope bucket need buckets and allocation.targets"
                )
            self._check_bucket_list(params.buckets, params_map, node, path, bucket_ids)
            if params.expression is not None:
                when_node = yaml_tree.get(params_map, "when") if params_map is not None else None
                for bucket_id, column in params.expression.bucket_references:
                    if bucket_id in bucket_ids:
                        continue
                    self._add(
                        IssueSeverity.ERROR,
                        f"{path}.params.when",
                        when_node or node,
                        f'Unknown bucket "{bucket_id}"{_bucket_hint(bucket_id, bucket_ids)} '
                        f"(column {column} of the expression)",
                        offset=column - 1,
                    )
        if spec.kind == ContributionGapRule.KIND and not has_contributions:
            self._warning(
                path,
                node,
                "contribution_gap needs a contributions: plan; without one the rule is always skipped",
            )

    def _check_bucket_list(
        self,
        buckets: tuple[str, ...],
        params_map: MappingNode | None,
        node: MappingNode,
        path: str,
        bucket_ids: list[str],
    ) -> None:
        for bucket_id in buckets:
            if bucket_id in bucket_ids:
                continue
            located = (
                yaml_tree.get(params_map, "buckets") if params_map is not None else None
            ) or node
            self._error(
                f"{path}.params.buckets",
                located,
                f'Unknown bucket "{bucket_id}"{_bucket_hint(bucket_id, bucket_ids)}',
            )

    def _watchlist(self, root: MappingNode) -> WatchlistCriteria:
        node = yaml_tree.get(root, "watchlist")
        if yaml_tree.is_absent(node):
            return WatchlistCriteria()
        assert node is not None
        if not isinstance(node, MappingNode):
            self._error("watchlist", node, "watchlist must be a mapping with criteria")
            return WatchlistCriteria()
        self._check_keys(node, "watchlist", ("criteria",))
        criteria = yaml_tree.get(node, "criteria")
        if yaml_tree.is_absent(criteria):
            return WatchlistCriteria()
        assert criteria is not None
        if not isinstance(criteria, MappingNode):
            self._error(
                "watchlist.criteria",
                criteria,
                "watchlist.criteria must be a mapping of criterion -> number",
            )
            return WatchlistCriteria()
        values: dict[str, float] = {}
        for entry in yaml_tree.entries(criteria):
            value = yaml_tree.to_plain(entry.value)
            path = f"watchlist.criteria.{entry.key}"
            if (
                not isinstance(value, int | float)
                or isinstance(value, bool)
                or not math.isfinite(value)
            ):
                self._error(path, entry.value, f"{entry.key} must be a number, got {value}")
                continue
            if entry.key not in WatchlistCriteria.KNOWN_KEYS:
                self._warning(
                    path,
                    entry.key_node,
                    f'Unknown criterion "{entry.key}"{did_you_mean(entry.key, WatchlistCriteria.KNOWN_KEYS)}; '
                    "it is kept for later stages",
                )
            values[entry.key] = float(value)
        return WatchlistCriteria(values)

    # --- helpers -------------------------------------------------------------------------------

    @property
    def _error_count(self) -> int:
        return sum(1 for issue in self._issues if issue.is_error)

    def _section[T](
        self,
        parent: MappingNode,
        key: str,
        read: Callable[[ParamReader], T],
        parent_path: str = "",
    ) -> T | None:
        """Reads the mapping under ``key`` with a ParamReader (unknown keys warned, issues located).
        None when the key is absent or null, or not a mapping (an error), or any error was recorded."""
        node = yaml_tree.get(parent, key)
        path = _join(parent_path, key)
        if yaml_tree.is_absent(node):
            return None
        assert node is not None
        if not isinstance(node, MappingNode):
            self._error(path, node, f"{key} must be a mapping")
            return None
        errors = ParamErrors()
        reader = ParamReader(yaml_tree.plain_map(node), errors)
        value = read(reader)
        reader.finish()
        self._report(errors.issues, node, path)
        return None if errors.has_errors else value

    def _check_keys(self, node: MappingNode, path: str, known: tuple[str, ...]) -> None:
        for entry in yaml_tree.entries(node):
            if entry.key not in known:
                self._warning(
                    _join(path, entry.key),
                    entry.key_node,
                    f'Unknown key "{entry.key}"{did_you_mean(entry.key, known)}; it is ignored',
                )

    def _report(self, issues: tuple[ParamIssue, ...], base: Node, base_path: str) -> None:
        """Converts param issues keyed relative to ``base`` into located strategy issues."""
        for issue in issues:
            node = yaml_tree.locate(base, issue.key, key_node=not issue.is_error) or base
            self._add(
                IssueSeverity.ERROR if issue.is_error else IssueSeverity.WARNING,
                _join(base_path, issue.key),
                node,
                issue.message,
                offset=issue.offset,
            )

    def _error(self, path: str, node: Node, message: str) -> None:
        self._add(IssueSeverity.ERROR, path, node, message)

    def _warning(self, path: str, node: Node, message: str) -> None:
        self._add(IssueSeverity.WARNING, path, node, message)

    def _add(
        self,
        severity: IssueSeverity,
        path: str,
        node: Node,
        message: str,
        offset: int | None = None,
    ) -> None:
        line, column = yaml_tree.position(node)
        if offset is not None:
            column = yaml_tree.exact_column(self._source, node, offset) or column
        self._issues.append(StrategyIssue(severity, path, message, line, column))


# --- section readers ----------------------------------------------------------------------------


def _read_data(reader: ParamReader) -> DataQualityPolicy:
    defaults = DataQualityPolicy()
    return DataQualityPolicy(
        max_price_age_days=reader.integer(
            "max_price_age_days", fallback=defaults.max_price_age_days, minimum=1
        ),
        max_stale_weight=reader.number(
            "max_stale_weight", fallback=defaults.max_stale_weight, minimum=0, maximum=1
        ),
        max_unclassified_weight=reader.number(
            "max_unclassified_weight",
            fallback=defaults.max_unclassified_weight,
            minimum=0,
            maximum=1,
        ),
        max_fx_age_days=reader.integer(
            "max_fx_age_days", fallback=defaults.max_fx_age_days, minimum=1
        ),
    )


def _read_contributions(reader: ParamReader) -> ContributionPlan:
    return ContributionPlan(
        monthly_amount=reader.decimal("monthly_amount", minimum=Decimal(0), exclusive_min=True),
        day_of_month=reader.optional_integer("day_of_month", minimum=1, maximum=31),
    )


def _read_match(reader: ParamReader) -> BucketMatch:
    return BucketMatch(
        asset_classes=reader.asset_classes("asset_class"),
        tags=frozenset(reader.strings("tags")),
        mics=frozenset(mic.upper() for mic in reader.strings("mic")),
        currencies=reader.currencies("currency"),
        instrument_ids=frozenset(reader.strings("instrument_ids")),
    )


def _read_benchmark(reader: ParamReader, header: _Header | None) -> Benchmark | None:
    benchmark_id = reader.optional_string("id")
    proxy = reader.optional_string("proxy")
    currencies = reader.currencies("currency")
    if benchmark_id is None:
        if not reader.has("id"):
            reader.errors.error("id", "benchmark.id is required (e.g. msci_acwi)")
    elif not _ID_PATTERN.match(benchmark_id):
        reader.errors.error("id", f'Benchmark id "{benchmark_id}" {_ID_RULE}')
    if proxy is None:
        if not reader.has("proxy"):
            reader.errors.error(
                "proxy",
                "benchmark.proxy is required: a Yahoo symbol or ISIN of an instrument tracking it",
            )
    elif not proxy.strip():
        reader.errors.error("proxy", "benchmark.proxy must not be empty")
    if len(currencies) > 1:
        reader.errors.error("currency", "benchmark.currency must be one currency code")
    currency = next(iter(currencies), None) or (header.base_currency if header else Currency.PLN)
    if benchmark_id is None or proxy is None:
        return None
    return Benchmark(id=benchmark_id, proxy=proxy.strip(), currency=currency)


def _read_notifications(reader: ParamReader) -> NotificationPolicy:
    immediate = NotificationPolicy().immediate
    if reader.has("immediate"):
        names = [member.value for member in SignalSeverity]
        chosen: set[SignalSeverity] = set()
        for name in reader.strings("immediate"):
            if name.lower() in names:
                chosen.add(SignalSeverity(name.lower()))
            else:
                reader.errors.error(
                    "immediate",
                    f'Unknown severity "{name}"{did_you_mean(name, names)}; allowed: {", ".join(names)}',
                )
        immediate = frozenset(chosen)
    weekday = NotificationPolicy().digest_weekday
    day = reader.optional_string("digest_weekday")
    if day is not None:
        days = [member.value for member in Weekday]
        if day.strip().lower() in days:
            weekday = Weekday(day.strip().lower())
        else:
            reader.errors.error(
                "digest_weekday",
                f'Unknown weekday "{day}"{did_you_mean(day, days)}; allowed: {", ".join(days)}',
            )
    return NotificationPolicy(immediate=immediate, digest_weekday=weekday)


def _bucket_hint(bucket_id: str, bucket_ids: list[str]) -> str:
    if not bucket_ids:
        return " (no buckets are defined)"
    return did_you_mean(bucket_id, bucket_ids)


def _join(base: str, key: str) -> str:
    if not key:
        return base
    if not base:
        return key
    return f"{base}{key}" if key.startswith("[") else f"{base}.{key}"
