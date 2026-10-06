"""contribution_gap: fires on a gap or no deposits, not fired within the allowance, skipped without a plan."""

from __future__ import annotations

from rules_fixtures import (
    candidate,
    context,
    d,
    day,
    describe,
    parse_issues,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from cashu.modules.investments.rules import (
    ContributionGapParams,
    ContributionGapRule,
    ContributionPlan,
    NotFired,
)

KIND = ContributionGapRule()
PLAN = ContributionPlan(monthly_amount=d("1000"), day_of_month=10)


def test_defaults_and_validation():
    assert parse_ok(KIND, {}) == ContributionGapParams(31, 10)
    assert "at least 1" in parse_issues(KIND, {"period_days": 0})[0].message
    assert "at least 0" in parse_issues(KIND, {"grace_days": -1})[0].message


def test_fires_when_the_gap_exceeds_period_plus_grace():
    value = portfolio(deposits=(day("2026-07-01"), day("2026-08-20")))
    outcomes = run(
        KIND, context(portfolio_value=value, contributions=PLAN), ContributionGapParams()
    )
    assert [describe(o) for o in outcomes] == ["fired r"]
    fired = candidate(outcomes[0])
    assert fired.message == "Brak wpłaty od 43 dni (ostatnia 2026-08-20); plan dopuszcza 41 dni."
    assert fired.payload["days_since_last_deposit"] == 43


def test_within_the_allowance_is_not_fired():
    value = portfolio(deposits=(day("2026-08-22"),))
    outcomes = run(
        KIND, context(portfolio_value=value, contributions=PLAN), ContributionGapParams()
    )
    assert [describe(o) for o in outcomes] == ["not_fired r"]
    assert isinstance(outcomes[0], NotFired)
    assert outcomes[0].details["last_deposit"] == "2026-08-22"


def test_no_deposits_at_all_fires():
    outcomes = run(KIND, context(contributions=PLAN), ContributionGapParams())
    assert (
        candidate(outcomes[0]).message
        == "Brak wpłat, choć plan zakłada 1\u00a0000 PLN miesięcznie."
    )


def test_without_a_plan_it_skips():
    outcomes = run(
        KIND,
        context(portfolio_value=portfolio(deposits=(day("2026-01-01"),))),
        ContributionGapParams(),
    )
    assert [describe(o) for o in outcomes] == ["skipped r"]
    assert skip_reason(outcomes[0]) == "Strategia nie ma planu wpłat"
