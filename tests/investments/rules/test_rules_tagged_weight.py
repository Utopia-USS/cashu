"""tagged_weight (2.1-A2): fires once for the tag set above max, not fired below, skipped on bad data."""

from __future__ import annotations

from rules_fixtures import (
    alloc,
    candidate,
    context,
    describe,
    h,
    instrument,
    parse_issues,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from finanse.modules.investments.domain import AssetClass, Currency
from finanse.modules.investments.rules import NotFired, TaggedWeightParams, TaggedWeightRule

KIND = TaggedWeightRule()
SPACE = instrument("SPACE", tags=("thematic", "space"))
ROBO = instrument("ROBO", asset_class=AssetClass.ETF, tags=("Thematic", "robotics"))
CORE = instrument("VWCE", asset_class=AssetClass.ETF, tags=("core",))
PARAMS = TaggedWeightParams(tags=("thematic",), max_weight=0.10)


class TestParseParams:
    def test_reads_one_tag_or_a_list(self):
        assert parse_ok(KIND, {"tags": "thematic", "max_weight": 0.1}) == PARAMS
        assert parse_ok(KIND, {"tags": ["a", "b"], "max_weight": 0.3}).tags == ("a", "b")

    def test_tags_and_max_weight_are_required(self):
        issues = parse_issues(KIND, {})
        assert [(i.key, i.message) for i in issues if i.is_error] == [
            ("tags", "tags is required (one tag or a list of tags)"),
            ("max_weight", "max_weight is required"),
        ]
        assert (
            "(fractions: 0.15 = 15%)"
            in parse_issues(KIND, {"tags": "a", "max_weight": 5})[0].message
        )


class TestEvaluate:
    def test_sums_holdings_carrying_all_tags_case_insensitively(self):
        value = portfolio([h(SPACE, value="800"), h(ROBO, value="700"), h(CORE, value="8500")])
        outcomes = run(KIND, context(portfolio_value=value), PARAMS)
        assert [describe(o) for o in outcomes] == ["fired r"]
        fired = candidate(outcomes[0])
        assert (
            fired.message
            == "Holdings tagged thematic are 15.0% of the portfolio (max 10.0%): ROBO, SPACE."
        )
        assert fired.payload["instruments"] == ["ROBO", "SPACE"]

    def test_all_tags_must_be_present(self):
        value = portfolio([h(SPACE, value="800"), h(ROBO, value="700"), h(CORE, value="8500")])
        outcomes = run(
            KIND, context(portfolio_value=value), TaggedWeightParams(("thematic", "space"), 0.05)
        )
        assert [describe(o) for o in outcomes] == ["fired r"]
        assert candidate(outcomes[0]).payload["instruments"] == ["SPACE"]

    def test_at_or_below_max_is_not_fired(self):
        value = portfolio([h(SPACE, value="1000"), h(CORE, value="9000")])
        outcomes = run(KIND, context(portfolio_value=value), PARAMS)
        assert [describe(o) for o in outcomes] == ["not_fired r"]
        assert isinstance(outcomes[0], NotFired)
        assert abs(outcomes[0].details["weight"] - 0.1) < 1e-9


class TestSkipsOnBadData:
    def test_stale_share_unpriced_holding_missing_fx_empty(self):
        stale = portfolio([h(SPACE, value="2000", stale=True), h(CORE, value="8000")])
        assert "Stale prices cover 20.0%" in skip_reason(
            run(KIND, context(portfolio_value=stale), PARAMS)[0]
        )
        unpriced = portfolio([h(SPACE, value=None), h(CORE, value="8000")])
        assert "No price for 1 holding(s) (SPACE)" in skip_reason(
            run(KIND, context(portfolio_value=unpriced), PARAMS)[0]
        )
        usd = instrument("ARKX", currency=Currency.USD, tags=("thematic",))
        no_fx = portfolio([h(usd), h(CORE)], missing_fx_currencies=frozenset({Currency.USD}))
        assert skip_reason(run(KIND, context(portfolio_value=no_fx), PARAMS)[0]).startswith(
            "No usable USD/PLN"
        )
        assert skip_reason(run(KIND, context(), PARAMS)[0]) == "The portfolio has no value yet"

    def test_unclassified_share_above_the_limit_skips(self):
        untagged = instrument("NEW", asset_class=AssetClass.ETF)
        value = portfolio([h(SPACE, value="500"), h(untagged, value="3000"), h(CORE, value="6500")])
        outcomes = run(
            KIND,
            context(
                portfolio_value=value,
                allocations=[alloc("core", weight=0.65, target=1.0)],
                unclassified=[value.valued[1]],
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert skip_reason(outcomes[0]).startswith(
            "Holdings that match no bucket are 30.0% of the portfolio"
        )
