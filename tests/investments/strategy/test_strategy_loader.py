"""strategy.yaml loader: typed config on valid input, one test per issue class with path, line, column and
"did you mean" hints. Port of the Kompas strategy_loader tests plus the 2.1-A2 and fork additions."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from finanse.modules.investments.domain import (
    AllocationPlan,
    AssetClass,
    BucketMatch,
    Currency,
    MarketView,
    PortfolioSnapshot,
    SignalSeverity,
    ValuedPortfolio,
)
from finanse.modules.investments.rules import (
    AllocationDriftParams,
    ContributionGapParams,
    ContributionPlan,
    CustomParams,
    DataQualityPolicy,
    DrawdownFromHighParams,
    Fired,
    InstrumentFilter,
    PositionConcentrationParams,
    RebalancePolicy,
    RuleContext,
    RulesEngine,
    TaggedWeightParams,
)
from finanse.modules.investments.rules.expr import Scope
from finanse.modules.investments.strategy import (
    Benchmark,
    IssueSeverity,
    NotificationPolicy,
    StrategyIssue,
    StrategyLoadResult,
    Weekday,
    load_strategy,
)

FULL = """\
version: 1
base_currency: pln
horizon_years: 10

contributions:
  monthly_amount: 2000
  day_of_month: 10

data: { max_price_age_days: 4, max_stale_weight: 0.1 }

buckets:
  - id: global_equity
    match: { asset_class: etf, tags: [global_equity] }
  - id: pl_equity
    match: { asset_class: equity, mic: xwar, currency: PLN }
  - id: bonds
    match: { asset_class: [bond, treasury_bond] }
  - id: cash
    match: { asset_class: cash }

allocation:
  targets: { global_equity: 0.60, pl_equity: 0.15, bonds: 0.20, cash: 0.05 }
  rebalance: { absolute_band_pp: 4, relative_band: 0.2, min_trade_value: 500 }

rules:
  - { id: drift, kind: allocation_drift, severity: action, cooldown_days: 14 }
  - { id: drift_bonds, kind: allocation_drift, params: { absolute_band_pp: 2, buckets: [bonds] } }
  - { id: max_single_stock, kind: position_concentration, params: { max_weight: 0.10, asset_class: equity } }
  - { id: dip_review, kind: drawdown_from_high, params: { window_days: 252, threshold: 0.15 }, severity: action }
  - { id: loss_review, kind: loss_from_cost, params: { threshold: 0.25, tags: [satellite] } }
  - { id: profit_review, kind: gain_from_cost, params: { threshold: 0.50 } }
  - { id: cash_band, kind: cash_level, params: { min_weight: 0.01, max_weight: 0.2 } }
  - { id: missed_deposit, kind: contribution_gap, params: { grace_days: 10 } }
  - { id: theme_cap, kind: tagged_weight, params: { tags: [thematic], max_weight: 0.1 } }
  - id: bonds_low
    kind: custom
    params:
      when: 'bucket_drift_pp("bonds") <= -5 and cash_weight > 2%'
      message: Bonds are below target
  - id: small_dip
    kind: custom
    params: { scope: instrument, instrument_ids: [i-PKN], when: "drawdown_from_high(20) > 10%" }

watchlist:
  criteria: { max_pe: 20, min_dividend_yield: 0.03, min_market_cap_pln: 1000000000 }

benchmark: { id: msci_acwi, proxy: VWCE.DE, currency: EUR }

notifications: { immediate: [action, info], digest_weekday: Friday }
"""

MINIMAL = "version: 1\nbase_currency: PLN\n"


def load(yaml_text: str, md: str | None = None) -> StrategyLoadResult:
    return load_strategy(yaml_text, md)


def issue_at(result: StrategyLoadResult, path: str) -> StrategyIssue:
    matches = [issue for issue in result.issues if issue.path == path]
    assert len(matches) == 1, (
        f"expected one issue at {path!r}, got {[str(i) for i in result.issues]}"
    )
    return matches[0]


class TestValidStrategies:
    def test_a_full_strategy_parses_into_a_typed_config(self):
        result = load(FULL, md="# Cel\nRosnąć.")
        assert result.issues == ()
        config = result.config
        assert config is not None
        assert (config.version, config.base_currency, config.horizon_years) == (1, Currency.PLN, 10)
        assert config.contributions == ContributionPlan(Decimal(2000), 10)
        assert config.data == DataQualityPolicy(max_price_age_days=4, max_stale_weight=0.1)
        assert config.markdown == "# Cel\nRosnąć."
        assert [b.id for b in config.allocation.buckets] == [
            "global_equity",
            "pl_equity",
            "bonds",
            "cash",
        ]
        assert config.allocation.buckets[1].match == BucketMatch(
            asset_classes=frozenset({AssetClass.EQUITY}),
            mics=frozenset({"XWAR"}),
            currencies=frozenset({Currency.PLN}),
        )
        assert config.allocation.buckets[2].match.asset_classes == {
            AssetClass.BOND,
            AssetClass.TREASURY_BOND,
        }
        assert dict(config.allocation.targets) == {
            "global_equity": 0.60,
            "pl_equity": 0.15,
            "bonds": 0.20,
            "cash": 0.05,
        }
        assert config.rebalance == RebalancePolicy(4, 0.2, Decimal(500))
        assert [r.id for r in config.rules] == [
            "drift",
            "drift_bonds",
            "max_single_stock",
            "dip_review",
            "loss_review",
            "profit_review",
            "cash_band",
            "missed_deposit",
            "theme_cap",
            "bonds_low",
            "small_dip",
        ]
        drift = config.rule("drift")
        assert drift is not None
        assert (drift.severity, drift.cooldown_days) == (SignalSeverity.ACTION, 14)
        assert isinstance(drift.params, AllocationDriftParams)
        assert drift.params.bands == config.rebalance, "defaults from allocation.rebalance"
        drift_bonds = config.rule("drift_bonds").params
        assert drift_bonds.bands.absolute_band_pp == 2, "rule params override rebalance"
        assert drift_bonds.bands.relative_band == 0.2
        assert drift_bonds.buckets == ("bonds",)
        assert config.rule("max_single_stock").params == PositionConcentrationParams(
            0.10, InstrumentFilter(frozenset({AssetClass.EQUITY}))
        )
        assert config.rule("dip_review").params == DrawdownFromHighParams(threshold=0.15)
        assert config.rule("loss_review").params.filter.tags == ("satellite",)
        assert config.rule("missed_deposit").params == ContributionGapParams()
        assert config.rule("theme_cap").params == TaggedWeightParams(("thematic",), 0.1)
        bonds_low = config.rule("bonds_low").params
        assert isinstance(bonds_low, CustomParams)
        assert (bonds_low.scope, bonds_low.message) == (Scope.PORTFOLIO, "Bonds are below target")
        small_dip = config.rule("small_dip").params
        assert small_dip.scope == Scope.INSTRUMENT
        assert small_dip.filter.instrument_ids == {"i-PKN"}
        assert config.rule("nope") is None
        assert config.watchlist.max_pe == 20
        assert config.watchlist.min_dividend_yield == 0.03
        assert config.watchlist.min_market_cap_pln == 1e9
        assert config.benchmark == Benchmark("msci_acwi", "VWCE.DE", Currency.EUR)
        assert config.notifications == NotificationPolicy(
            frozenset({SignalSeverity.ACTION, SignalSeverity.INFO}), Weekday.FRIDAY
        )
        assert Weekday.FRIDAY.iso_number == 5

    def test_the_parsed_rules_run_in_the_engine(self):
        config = load(FULL).config
        as_of = date(2026, 10, 2)
        ctx = RuleContext(
            profile_id="p",
            as_of=as_of,
            portfolio=ValuedPortfolio(
                snapshot=PortfolioSnapshot(profile_id="p", as_of=as_of),
                base_currency=Currency.PLN,
                cash_base=Decimal(0),
                total_base=Decimal(0),
                stale_weight=0.0,
            ),
            market=MarketView(as_of=as_of),
            contributions=config.contributions,
        )
        outcomes = RulesEngine(config.rules).evaluate(ctx)
        assert {o.rule_id for o in outcomes} == {r.id for r in config.rules}
        fired = [o for o in outcomes if isinstance(o, Fired)]
        assert [o.rule_id for o in fired] == ["missed_deposit"], "no deposits yet"

    def test_a_minimal_strategy_uses_defaults(self):
        config = load(MINIMAL).config
        assert config.allocation == AllocationPlan()
        assert config.rebalance == RebalancePolicy()
        assert config.data == DataQualityPolicy()
        assert config.contributions is None
        assert config.rules == ()
        assert config.watchlist.is_empty
        assert config.horizon_years is None
        assert config.benchmark is None
        assert config.notifications == NotificationPolicy(
            frozenset({SignalSeverity.ACTION}), Weekday.SUNDAY
        )

    def test_data_policy_keys_are_optional_read_and_validated(self):
        defaults = DataQualityPolicy()
        assert (
            defaults.max_price_age_days,
            defaults.max_stale_weight,
            defaults.max_unclassified_weight,
            defaults.max_fx_age_days,
        ) == (5, 0.05, 0.02, 10)
        result = load(MINIMAL + "data: { max_unclassified_weight: 0.1, max_fx_age_days: 7 }\n")
        assert result.issues == ()
        assert result.config.data == DataQualityPolicy(
            max_unclassified_weight=0.1, max_fx_age_days=7
        )
        bad = load(
            MINIMAL
            + "data: { max_unclassified_weight: 2, max_fx_age_days: 0, max_price_age_days: 1.5 }\n"
        )
        assert "(fractions: 0.15 = 15%)" in issue_at(bad, "data.max_unclassified_weight").message
        assert "at least 1" in issue_at(bad, "data.max_fx_age_days").message
        assert "whole number, got 1.5" in issue_at(bad, "data.max_price_age_days").message

    def test_explicit_nulls_count_as_absent_sections(self):
        result = load(MINIMAL + "data:\nrules:\nwatchlist:\nbenchmark:\nnotifications:\n")
        assert result.issues == ()
        assert result.config.data == DataQualityPolicy()

    def test_notifications_can_disable_immediate_alerts(self):
        result = load(MINIMAL + "notifications: { immediate: [] }\n")
        assert result.config.notifications.immediate == frozenset()


class TestDocumentErrors:
    def test_yaml_syntax_error_carries_the_parser_location(self):
        result = load("version: 1\nbase_currency: [PLN\n")
        assert result.config is None
        issue = result.errors[0]
        assert len(result.errors) == 1
        assert issue.path == ""
        assert issue.message.startswith("Invalid YAML: ")
        assert issue.line is not None and issue.column is not None

    def test_duplicate_keys_are_an_error_at_the_duplicate(self):
        issue = load("version: 1\nbase_currency: PLN\nversion: 1\n").errors[0]
        assert (
            issue.message
            == 'Invalid YAML: duplicate mapping key "version" (first defined on line 1)'
        )
        assert (issue.line, issue.column) == (3, 1)

    def test_nested_duplicate_keys_too(self):
        issue = load(MINIMAL + "data:\n  max_stale_weight: 0.1\n  max_stale_weight: 0.2\n").errors[
            0
        ]
        assert (issue.line, issue.column) == (5, 3)

    def test_an_empty_file_or_a_non_mapping_document(self):
        assert "strategy.yaml is empty" in load("").errors[0].message
        assert "strategy.yaml is empty" in load("# only a comment\n").errors[0].message
        assert "must be a mapping" in load("- a\n- b\n").errors[0].message
        assert "must be a mapping" in load("just text\n").errors[0].message

    def test_anchors_aliases_merge_keys_and_custom_tags_are_rejected(self):
        alias = load(MINIMAL + "data: &d { max_stale_weight: 0.1 }\nwatchlist: *d\n").errors[0]
        assert alias.message == "YAML anchors and aliases (& and *) are not supported"
        merge = load(MINIMAL + "data:\n  <<: { max_stale_weight: 0.1 }\n").errors[0]
        assert merge.message == "YAML merge keys (<<) are not supported"
        assert (merge.line, merge.column) == (4, 3)
        tag = load(MINIMAL + "data: !!python/object:os.system { }\n").errors[0]
        assert tag.message.startswith("Unsupported YAML tag")
        local_tag = load(MINIMAL + "horizon_years: !custom 5\n").errors[0]
        assert local_tag.message == "Unsupported YAML tag !custom"
        complex_key = load(MINIMAL + "? [a, b]\n: 1\n").errors[0]
        assert complex_key.message == "Mapping keys must be plain text"

    def test_a_billion_laughs_document_is_rejected(self):
        laughs = 'a: &a ["lol","lol"]\nb: &b [*a,*a,*a]\nc: &c [*b,*b,*b]\nd: [*c,*c,*c]\n'
        assert "aliases" in load(MINIMAL + laughs).errors[0].message

    def test_huge_and_deeply_nested_documents_are_rejected(self):
        huge = MINIMAL + "# " + "x" * 600_000 + "\n"
        assert "too large" in load(huge).errors[0].message
        deep = MINIMAL + "watchlist: " + "[" * 5000 + "]" * 5000 + "\n"
        issue = load(deep).errors[0]
        assert issue.message == "strategy.yaml is nested too deeply (max 32 levels)"
        assert (issue.line, issue.column) == (3, 43)


class TestHeader:
    def test_version_and_base_currency_are_required(self):
        result = load("horizon_years: 5\n")
        assert issue_at(result, "version").message == "version is required"
        assert "base_currency is required" in issue_at(result, "base_currency").message
        assert result.config is None

    def test_unsupported_or_non_integer_version(self):
        assert issue_at(load("version: 2\nbase_currency: PLN\n"), "version").message == (
            "Unsupported version 2 (supported: 1)"
        )
        issue = issue_at(load('version: "1"\nbase_currency: PLN\n'), "version")
        assert "whole number" in issue.message
        assert (issue.line, issue.column) == (1, 10)
        assert (
            "whole number, got true"
            in issue_at(load("version: true\nbase_currency: PLN\n"), "version").message
        )

    def test_invalid_currency_is_an_error_non_pln_a_warning(self):
        assert issue_at(load("version: 1\nbase_currency: zloty\n"), "base_currency").is_error
        eur = load("version: 1\nbase_currency: EUR\n")
        assert eur.is_valid
        assert "Only PLN is fully supported" in eur.warnings[0].message
        assert eur.config.base_currency == Currency.EUR

    def test_horizon_years_range(self):
        assert (
            "at least 1" in issue_at(load(MINIMAL + "horizon_years: 0\n"), "horizon_years").message
        )
        assert (
            "at most 100"
            in issue_at(load(MINIMAL + "horizon_years: 101\n"), "horizon_years").message
        )


class TestUnknownKeys:
    def test_unknown_keys_at_every_level_are_warnings_with_hints_at_the_key(self):
        result = load(
            """\
version: 1
base_currency: PLN
horizon_yaers: 10
data: { max_stale_wieght: 0.1 }
buckets:
  - id: all
    match: {}
    note: everything
allocation:
  targets: { all: 1 }
  rebalence: { absolute_band_pp: 5 }
rules:
  - id: conc
    kind: position_concentration
    serverity: action
    params: { max_weight: 0.1, asset_clas: equity }
watchlist:
  criterea: { max_pe: 20 }
benchmark: { id: x, proxy: y, curency: PLN }
notifications: { imediate: [action] }
"""
        )
        assert result.is_valid
        assert result.errors == []
        by_path = {issue.path: issue for issue in result.warnings}
        assert list(by_path) == [
            "horizon_yaers",
            "data.max_stale_wieght",
            "buckets[0].note",
            "allocation.rebalence",
            "rules[0].serverity",
            "rules[0].params.asset_clas",
            "watchlist.criterea",
            "benchmark.curency",
            "notifications.imediate",
        ]
        assert by_path["horizon_yaers"].message == (
            'Unknown key "horizon_yaers" (did you mean "horizon_years"?); it is ignored'
        )
        assert 'did you mean "max_stale_weight"' in by_path["data.max_stale_wieght"].message
        assert 'did you mean "rebalance"' in by_path["allocation.rebalence"].message
        assert 'did you mean "severity"' in by_path["rules[0].serverity"].message
        assert 'did you mean "asset_class"' in by_path["rules[0].params.asset_clas"].message
        assert 'did you mean "currency"' in by_path["benchmark.curency"].message
        assert 'did you mean "immediate"' in by_path["notifications.imediate"].message
        assert "did you mean" not in by_path["buckets[0].note"].message
        param = by_path["rules[0].params.asset_clas"]
        assert (param.line, param.column) == (16, 32), "points at the key"
        assert (by_path["horizon_yaers"].line, by_path["horizon_yaers"].column) == (3, 1)


class TestBucketsAndAllocation:
    TWO_BUCKETS = """\
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
"""

    def strategy(self, buckets: str = "", allocation: str = "") -> str:
        return MINIMAL + buckets + allocation

    def test_targets_must_sum_to_1(self):
        result = load(
            self.strategy(self.TWO_BUCKETS, "allocation:\n  targets: { stocks: 0.9, cash: 0.05 }\n")
        )
        issue = issue_at(result, "allocation.targets")
        assert issue.message == "Targets sum to 0.950, expected 1 (+-0.001)"
        assert (issue.line, issue.column) == (9, 12)
        assert load(
            self.strategy(self.TWO_BUCKETS, "allocation:\n  targets: { stocks: 0.9995, cash: 0 }\n")
        ).is_valid

    def test_targets_reference_defined_buckets_and_stay_within_0_1(self):
        result = load(
            self.strategy(self.TWO_BUCKETS, "allocation:\n  targets: { stoks: 0.95, cash: 1.05 }\n")
        )
        unknown = issue_at(result, "allocation.targets.stoks")
        assert (
            unknown.message == 'Target references undefined bucket "stoks" (did you mean "stocks"?)'
        )
        assert (unknown.line, unknown.column) == (9, 14)
        assert "between 0 and 1" in issue_at(result, "allocation.targets.cash").message
        assert not [i for i in result.errors if i.path == "allocation.targets"], (
            "no sum check on bad values"
        )

    def test_targets_without_any_bucket(self):
        issue = issue_at(
            load(self.strategy(allocation="allocation:\n  targets: { stocks: 1 }\n")),
            "allocation.targets.stocks",
        )
        assert "no buckets are defined" in issue.message

    def test_allocation_needs_targets_and_a_bucket_without_target_gets_0(self):
        assert issue_at(
            load(self.strategy(self.TWO_BUCKETS, "allocation: {}\n")), "allocation.targets"
        ).is_error
        result = load(self.strategy(self.TWO_BUCKETS, "allocation:\n  targets: { stocks: 1 }\n"))
        assert result.is_valid
        assert 'Bucket "cash" has no target' in result.warnings[0].message
        assert dict(result.config.allocation.targets) == {"stocks": 1.0, "cash": 0.0}
        assert issue_at(
            load(self.strategy(self.TWO_BUCKETS, "allocation: [1]\n")), "allocation"
        ).is_error
        assert issue_at(
            load(self.strategy(self.TWO_BUCKETS, "allocation: { targets: [1] }\n")),
            "allocation.targets",
        ).is_error

    def test_buckets_without_allocation_are_a_warning(self):
        result = load(self.strategy(self.TWO_BUCKETS))
        assert result.is_valid
        assert "allocation.targets is missing" in issue_at(result, "buckets").message

    def test_bucket_ids_required_well_formed_unique_and_match_required(self):
        result = load(
            self.strategy(
                """\
buckets:
  - id: stocks
    match: { asset_class: equity }
  - id: stocks
    match: { asset_class: etf }
  - id: "bad id"
    match: {}
  - match: {}
  - id: nomatch
  - just a string
"""
            )
        )
        assert (
            issue_at(result, "buckets[1].id").message
            == 'Duplicate bucket id "stocks" (first defined on line 4)'
        )
        assert "may only contain letters" in issue_at(result, "buckets[2].id").message
        assert issue_at(result, "buckets[3].id").message == "Bucket id is required"
        assert "match is required" in issue_at(result, "buckets[4].match").message
        assert "must be a mapping" in issue_at(result, "buckets[5]").message
        assert issue_at(load(self.strategy("buckets: { a: 1 }\n")), "buckets").is_error

    def test_match_values_are_validated_with_hints(self):
        result = load(
            self.strategy(
                "buckets:\n  - id: a\n    match: { asset_class: [equity, bnd], currency: euro, tags: [{x: 1}] }\n"
            )
        )
        asset_class = issue_at(result, "buckets[0].match.asset_class")
        assert 'Unknown asset class "bnd" (did you mean "bond"?)' in asset_class.message
        assert (asset_class.line, asset_class.column) == (5, 27)
        assert (
            '"euro" is not a three-letter' in issue_at(result, "buckets[0].match.currency").message
        )
        assert "got a mapping" in issue_at(result, "buckets[0].match.tags[0]").message

    def test_claim_is_a_known_asset_class(self):
        result = load(
            self.strategy("buckets:\n  - id: c\n    match: { asset_class: [claim, cash] }\n")
        )
        assert result.config.allocation.buckets[0].match.asset_classes == {
            AssetClass.CLAIM,
            AssetClass.CASH,
        }

    def test_a_catch_all_bucket_not_last_and_a_missing_cash_bucket_are_warnings(self):
        result = load(
            self.strategy(
                "buckets:\n  - id: everything\n    match: {}\n  - id: stocks\n    match: { asset_class: equity }\n",
                "allocation:\n  targets: { everything: 0.5, stocks: 0.5 }\n",
            )
        )
        assert result.is_valid
        assert "matches every instrument" in issue_at(result, "buckets[0].match").message
        no_cash = load(
            self.strategy(
                "buckets:\n  - id: stocks\n    match: { asset_class: equity }\n",
                "allocation:\n  targets: { stocks: 1 }\n",
            )
        )
        assert "No bucket matches asset_class: cash" in issue_at(no_cash, "buckets").message

    def test_rebalance_values_are_validated(self):
        result = load(
            self.strategy(
                self.TWO_BUCKETS,
                "allocation:\n  targets: { stocks: 1 }\n  rebalance: { absolute_band_pp: 0, min_trade_value: -5 }\n",
            )
        )
        assert "greater than 0" in issue_at(result, "allocation.rebalance.absolute_band_pp").message
        assert "at least 0" in issue_at(result, "allocation.rebalance.min_trade_value").message


class TestRules:
    def with_rules(self, rules: str) -> str:
        return MINIMAL + rules

    def test_ids_unique_well_formed_id_and_kind_required(self):
        result = load(
            self.with_rules(
                """\
rules:
  - { id: loss, kind: loss_from_cost, params: { threshold: 0.2 } }
  - { id: loss, kind: loss_from_cost, params: { threshold: 0.3 } }
  - { id: "a|b", kind: cash_level, params: { max_weight: 0.1 } }
  - { kind: cash_level, params: { max_weight: 0.1 } }
  - { id: no_kind }
  - 42
"""
            )
        )
        assert (
            issue_at(result, "rules[1].id").message
            == 'Duplicate rule id "loss" (first defined on line 4)'
        )
        assert "may only contain" in issue_at(result, "rules[2].id").message
        assert issue_at(result, "rules[3].id").message == "Rule id is required"
        assert issue_at(result, "rules[4].kind").message.startswith(
            "Rule kind is required; known: allocation_drift,"
        )
        assert "must be a mapping" in issue_at(result, "rules[5]").message
        assert result.config is None

    def test_unknown_kind_is_an_error_with_the_closest_known_kind(self):
        issue = issue_at(
            load(self.with_rules("rules:\n  - { id: x, kind: loss_from_costs }\n")), "rules[0].kind"
        )
        assert issue.message.startswith(
            'Unknown rule kind "loss_from_costs" (did you mean "loss_from_cost"?)'
        )
        assert issue.message.endswith("tagged_weight, custom")
        assert (issue.line, issue.column) == (4, 20)

    def test_params_are_validated_by_the_kind_and_located_at_the_value(self):
        result = load(
            self.with_rules(
                """\
rules:
  - id: dip
    kind: drawdown_from_high
    params:
      threshold: 15
      window_days: soon
  - id: conc
    kind: position_concentration
"""
            )
        )
        threshold = issue_at(result, "rules[0].params.threshold")
        assert threshold.message == (
            "threshold must be greater than 0 and less than 1, got 15 (fractions: 0.15 = 15%)"
        )
        assert (threshold.line, threshold.column) == (7, 18)
        assert 'whole number, got "soon"' in issue_at(result, "rules[0].params.window_days").message
        missing = issue_at(result, "rules[1].params.max_weight")
        assert missing.message == "max_weight is required"
        assert (missing.line, missing.column) == (9, 5), (
            "falls back to the rule when params are absent"
        )

    def test_filters_are_validated(self):
        result = load(
            self.with_rules(
                "rules:\n  - { id: l, kind: loss_from_cost, params: { threshold: 0.2, tags: [[x]], asset_class: stocks } }\n"
            )
        )
        assert "got a list" in issue_at(result, "rules[0].params.tags[0]").message
        assert "Unknown asset class" in issue_at(result, "rules[0].params.asset_class").message

    def test_severity_cooldown_and_params_shape(self):
        result = load(
            self.with_rules(
                """\
rules:
  - { id: a, kind: cash_level, params: { max_weight: 0.1 }, severity: urgent }
  - { id: b, kind: cash_level, params: { max_weight: 0.1 }, cooldown_days: -1 }
  - { id: c, kind: cash_level, params: [max_weight] }
"""
            )
        )
        assert "allowed: info, action" in issue_at(result, "rules[0].severity").message
        assert "at least 0" in issue_at(result, "rules[1].cooldown_days").message
        assert issue_at(result, "rules[2].params").message == "params must be a mapping"

    def test_allocation_drift_needs_targets_and_known_buckets(self):
        assert issue_at(
            load(self.with_rules("rules:\n  - { id: d, kind: allocation_drift }\n")), "rules[0]"
        ).message == ("allocation_drift needs buckets and allocation.targets")
        result = load(
            """\
version: 1
base_currency: PLN
buckets:
  - { id: stocks, match: { asset_class: equity } }
  - { id: cash, match: { asset_class: cash } }
allocation: { targets: { stocks: 0.9, cash: 0.1 } }
rules:
  - { id: d, kind: allocation_drift, params: { buckets: [stocks, cahs] } }
"""
        )
        assert (
            issue_at(result, "rules[0].params.buckets").message
            == 'Unknown bucket "cahs" (did you mean "cash"?)'
        )

    def test_rebalance_without_drift_rule_and_contribution_gap_without_plan_are_warnings(self):
        result = load(
            """\
version: 1
base_currency: PLN
buckets:
  - { id: all, match: {} }
allocation:
  targets: { all: 1 }
  rebalance: { absolute_band_pp: 5 }
rules:
  - { id: deposits, kind: contribution_gap }
"""
        )
        assert result.is_valid
        assert (
            "only checked by an allocation_drift rule"
            in issue_at(result, "allocation.rebalance").message
        )
        assert (
            "contribution_gap needs a contributions: plan" in issue_at(result, "rules[0]").message
        )

    def test_rules_must_be_a_list(self):
        assert issue_at(load(self.with_rules("rules: { a: 1 }\n")), "rules").is_error

    def test_tagged_weight_params(self):
        result = load(
            self.with_rules(
                "rules:\n  - { id: t, kind: tagged_weight, params: { max_weight: 0.3 } }\n"
            )
        )
        assert (
            issue_at(result, "rules[0].params.tags").message
            == "tags is required (one tag or a list of tags)"
        )


class TestCustomRules:
    def with_rules(self, rules: str) -> str:
        return (
            MINIMAL
            + "buckets:\n  - { id: bonds, match: { asset_class: bond } }\n  - { id: cash, match: { asset_class: cash } }\nallocation: { targets: { bonds: 0.9, cash: 0.1 } }\n"
            + rules
        )

    def test_expression_errors_point_at_the_exact_yaml_column(self):
        result = load(
            MINIMAL
            + 'rules:\n  - { id: c, kind: custom, params: { scope: instrument, when: "weight >> 1" } }\n'
        )
        issue = issue_at(result, "rules[0].params.when")
        assert issue.message == "Expected a value, found '>' (column 9 of the expression)"
        line = 'rules:\n  - { id: c, kind: custom, params: { scope: instrument, when: "weight >> 1" } }'.splitlines()[
            1
        ]
        assert (issue.line, issue.column) == (4, line.index("weight") + 1 + 8)

    def test_plain_and_block_scalars(self):
        plain = load(
            MINIMAL
            + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: cash_weight >> 1\n"
        )
        issue = issue_at(plain, "rules[0].params.when")
        assert (issue.line, issue.column) == (7, 13 + 13)
        block = load(
            MINIMAL
            + "rules:\n  - id: c\n    kind: custom\n    params:\n      when: >\n        cash_weight >> 1\n"
        )
        block_issue = issue_at(block, "rules[0].params.when")
        assert block_issue.line == 7, "block scalars fall back to the value's start"
        assert "(column 14 of the expression)" in block_issue.message

    def test_unknown_names_scope_errors_and_hints(self):
        result = load(
            MINIMAL
            + 'rules:\n  - { id: a, kind: custom, params: { when: "wieght > 1", scope: instrument } }\n'
            + '  - { id: b, kind: custom, params: { when: "weight > 1" } }\n'
            + '  - { id: c, kind: custom, params: { when: "cash_weight > 1", scope: instrumnet } }\n'
        )
        assert issue_at(result, "rules[0].params.when").message.startswith(
            'Unknown name "wieght" (did you mean "weight"?)'
        )
        assert (
            "not available in scope portfolio" in issue_at(result, "rules[1].params.when").message
        )
        assert 'did you mean "instrument"' in issue_at(result, "rules[2].params.scope").message

    def test_bucket_references_are_cross_checked(self):
        result = load(
            self.with_rules(
                'rules:\n  - id: b\n    kind: custom\n    params:\n      when: bucket_weight("bnds") > 50%\n'
                "  - { id: s, kind: custom, params: { scope: bucket, buckets: [csh], when: drift_pp > 5 } }\n"
            )
        )
        when = issue_at(result, "rules[0].params.when")
        assert (
            when.message
            == 'Unknown bucket "bnds" (did you mean "bonds"?) (column 1 of the expression)'
        )
        assert (when.line, when.column) == (11, 13)
        assert (
            issue_at(result, "rules[1].params.buckets").message
            == 'Unknown bucket "csh" (did you mean "cash"?)'
        )

    def test_bucket_scope_and_bucket_metrics_need_buckets(self):
        result = load(
            MINIMAL
            + "rules:\n  - { id: s, kind: custom, params: { scope: bucket, when: drift_pp > 5 } }\n"
            + '  - { id: p, kind: custom, params: { when: bucket_weight("x") > 5% } }\n'
        )
        assert (
            issue_at(result, "rules[0]").message
            == "custom rules with scope bucket need buckets and allocation.targets"
        )
        assert "(no buckets are defined)" in issue_at(result, "rules[1].params.when").message

    def test_valid_custom_rules_load(self):
        result = load(
            self.with_rules(
                "rules:\n"
                '  - { id: a, kind: custom, params: { when: "bucket_drift_pp(\\"bonds\\") < -5" } }\n'
                "  - { id: b, kind: custom, params: { scope: bucket, buckets: [bonds], when: drift_rel < -25% } }\n"
            )
        )
        assert result.issues == ()
        assert [r.params.scope for r in result.config.rules] == [Scope.PORTFOLIO, Scope.BUCKET]


class TestBenchmarkAndNotifications:
    def test_benchmark_requires_id_and_proxy_currency_defaults_to_base(self):
        assert load(
            MINIMAL + "benchmark: { id: acwi, proxy: SPYI.DE }\n"
        ).config.benchmark == Benchmark("acwi", "SPYI.DE", Currency.PLN)
        result = load(MINIMAL + "benchmark: { currency: euro }\n")
        assert (
            issue_at(result, "benchmark.id").message == "benchmark.id is required (e.g. msci_acwi)"
        )
        assert issue_at(result, "benchmark.proxy").message.startswith("benchmark.proxy is required")
        assert '"euro" is not a three-letter' in issue_at(result, "benchmark.currency").message
        assert (
            "may only contain"
            in issue_at(
                load(MINIMAL + "benchmark: { id: a b, proxy: X }\n"), "benchmark.id"
            ).message
        )
        assert (
            issue_at(load(MINIMAL + "benchmark: acwi\n"), "benchmark").message
            == "benchmark must be a mapping"
        )

    def test_notifications_are_validated_with_hints(self):
        result = load(MINIMAL + "notifications: { immediate: [acton], digest_weekday: sundy }\n")
        assert issue_at(result, "notifications.immediate").message.startswith(
            'Unknown severity "acton" (did you mean "action"?)'
        )
        assert issue_at(result, "notifications.digest_weekday").message.startswith(
            'Unknown weekday "sundy" (did you mean "sunday"?)'
        )
        scalar = load(MINIMAL + "notifications: { immediate: action }\n")
        assert scalar.config.notifications.immediate == {SignalSeverity.ACTION}
        assert (
            "text or a list"
            in issue_at(
                load(MINIMAL + "notifications: { immediate: { a: 1 } }\n"),
                "notifications.immediate",
            ).message
        )


class TestOtherSections:
    def test_contributions_and_data_are_validated(self):
        result = load(
            MINIMAL
            + "contributions: { monthly_amount: 0, day_of_month: 32 }\ndata: { max_stale_weight: 5 }\n"
        )
        assert "greater than 0" in issue_at(result, "contributions.monthly_amount").message
        assert "at most 31" in issue_at(result, "contributions.day_of_month").message
        assert "(fractions: 0.15 = 15%)" in issue_at(result, "data.max_stale_weight").message
        assert issue_at(
            load(MINIMAL + "contributions: { day_of_month: 5 }\n"), "contributions.monthly_amount"
        ).message == ("monthly_amount is required")
        assert issue_at(load(MINIMAL + "data: 5\n"), "data").message == "data must be a mapping"
        exact = load(MINIMAL + 'contributions: { monthly_amount: "1234.56" }\n')
        assert exact.config.contributions.monthly_amount == Decimal("1234.56")

    def test_watchlist_criteria(self):
        result = load(MINIMAL + "watchlist:\n  criteria: { max_pee: 20, min_roe: 0.1 }\n")
        assert result.is_valid
        assert 'did you mean "max_pe"' in issue_at(result, "watchlist.criteria.max_pee").message
        assert dict(result.config.watchlist.values) == {"max_pee": 20.0, "min_roe": 0.1}
        assert issue_at(
            load(MINIMAL + "watchlist:\n  criteria: { max_pe: low }\n"), "watchlist.criteria.max_pe"
        ).is_error
        assert issue_at(
            load(MINIMAL + "watchlist:\n  criteria: { max_pe: .inf }\n"),
            "watchlist.criteria.max_pe",
        ).is_error
        assert issue_at(load(MINIMAL + "watchlist: [1]\n"), "watchlist").is_error
        assert issue_at(
            load(MINIMAL + "watchlist: { criteria: [1] }\n"), "watchlist.criteria"
        ).is_error

    def test_an_empty_strategy_md_is_a_warning_without_location(self):
        result = load(MINIMAL, md="  \n")
        assert result.is_valid
        issue = result.warnings[0]
        assert (issue.path, issue.line, issue.severity) == (
            "strategy.md",
            None,
            IssueSeverity.WARNING,
        )


def test_strategy_issue_renders_path_and_location():
    issue = issue_at(load("version: 2\nbase_currency: PLN\n"), "version")
    assert str(issue) == "error version (line 1, column 10): Unsupported version 2 (supported: 1)"
    assert str(StrategyIssue(IssueSeverity.WARNING, "strategy.md", "m")) == "warning strategy.md: m"
    assert str(StrategyIssue(IssueSeverity.ERROR, "", "m", 1, 1)) == "error (line 1, column 1): m"


@pytest.mark.parametrize(
    "text", ["version: 1\nbase_currency: PLN\nrules: 5\n", "version: [1]\nbase_currency: [PLN]\n"]
)
def test_garbage_never_raises(text):
    assert load(text).config is None
