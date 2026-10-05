"""Month close: surplus per currency, the cushion top-up rule and the planned contribution from the
investments strategy (synthetic household from conftest.seed_demo, September 2026: PLN income 9000,
spending 4275.75, surplus 4724.25; EUR spending 9.99)."""

from __future__ import annotations

import json
import os
from datetime import date

import pytest
from sqlmodel import select

from finanse.core import paths, profiles
from finanse.db import get_session
from finanse.models import Account
from finanse.modules.budget import monthclose
from finanse.modules.budget import settings as budget_settings
from finanse.modules.investments.models import InvStrategyVersion
from finanse.modules.investments.service import files as inv_files

SEPT = "/api/budget/month-close?month=2026-09"
ALL_MODULES = ["budget", "assets", "loans", "investments"]
STRATEGY_PLAN = """version: 1
base_currency: {currency}
contributions:
  monthly_amount: {amount}
  day_of_month: 10
"""


def _pln(close: dict) -> dict:
    return next(c for c in close["currencies"] if c["currency"] == "PLN")


def _account_id(name: str) -> int:
    with get_session() as s:
        return s.exec(select(Account).where(Account.name == name)).one().id


def _write_strategy(text: str, slug: str = "default") -> None:
    path = inv_files.strategy_yaml_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _enable_investments(api, slug: str = "default") -> None:
    r = api.put(f"/api/profiles/{slug}/modules", json={"modules": ALL_MODULES})
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- #
# Numbers and the default month
# --------------------------------------------------------------------------- #

def test_month_close_without_investments(api):
    close = api.get(SEPT).json()
    assert close["month"] == "2026-09" and close["base_currency"] == "PLN"
    assert close["complete"] is (date(2026, 9, 30) < date.today())  # noqa: DTZ011
    assert close["investing"] is None and close["cushion"] is None
    pln = _pln(close)
    assert (pln["income"], pln["spending"], pln["surplus"]) == (9000.0, 4275.75, 4724.25)
    assert pln["suggested_transfer"] == 4724.25 and pln["cushion_top_up"] == 0.0
    top = {r["category"]: r["amount"] for r in pln["spending_by_category"]}
    assert top["loans"] == 3000.0 and top["groceries"] == pytest.approx(227.75)
    assert "transfer" not in top and "cash_withdrawal" not in top
    assert [r["category"] for r in pln["income_by_category"]] == ["income_salary"]


def test_month_close_rejects_a_bad_month(api):
    for bad in ("2026-13", "2026/09", "26-09", "september"):
        r = api.get(f"/api/budget/month-close?month={bad}")
        assert r.status_code == 422, bad
        assert r.json()["detail"] == "month must be YYYY-MM"


def test_default_month_is_the_newest_closed_month_with_data(seeded_engine):
    with get_session() as s:
        profile = profiles.default_profile(s)
        stored = budget_settings.BudgetSettings()
        oct5 = monthclose.month_close(s, profile, stored, today=date(2026, 10, 5))
        assert (oct5.label, oct5.complete) == ("2026-09", True)
        sept20 = monthclose.month_close(s, profile, stored, today=date(2026, 9, 20))
        assert sept20.label == "2026-08"  # the running month is not closed yet
        later = monthclose.month_close(s, profile, stored, today=date(2027, 3, 1))
        assert later.label == "2026-09"  # the newest month with data
        running = monthclose.month_close(
            s, profile, stored, year=2026, month=9, today=date(2026, 9, 20)
        )
        assert running.complete is False


def test_empty_profile_month_close(api):
    api.post("/api/profiles", json={"name": "Pusty", "modules": ["budget"]})
    close = api.get("/api/p/pusty/budget/month-close?month=2026-09").json()
    assert close["currencies"] == [] and close["first_month"] is None
    assert close["investing"] is None and close["cushion"] is None


# --------------------------------------------------------------------------- #
# Investments plan (read only, only when the module is on)
# --------------------------------------------------------------------------- #

def test_planned_contribution_is_compared_when_investments_is_on(api):
    _write_strategy(STRATEGY_PLAN.format(currency="PLN", amount=2000))
    assert api.get(SEPT).json()["investing"] is None  # the module is off: the strategy is ignored

    _enable_investments(api)
    inv = api.get(SEPT).json()["investing"]
    assert inv["enabled"] is True and inv["strategy_state"] == "valid"
    assert inv["planned"] == {"amount": 2000.0, "currency": "PLN", "day_of_month": 10}
    assert inv["comparison"] == {
        "currency": "PLN", "has_data": True, "surplus": 4724.25, "suggested_transfer": 4724.25,
        "difference": 2724.25, "status": "covered",
    }
    with get_session() as s:  # reading the plan never records a strategy version
        assert s.exec(select(InvStrategyVersion)).all() == []


def test_investments_on_without_a_usable_plan(api):
    _enable_investments(api)
    inv = api.get(SEPT).json()["investing"]
    assert inv == {"enabled": True, "strategy_state": "missing", "planned": None, "comparison": None}

    _write_strategy("version: 1\nbase_currency: PLN\n")  # valid, but no contributions section
    inv = api.get(SEPT).json()["investing"]
    assert (inv["strategy_state"], inv["planned"]) == ("valid", None)

    _write_strategy("version: 2\nbase_currency: PLN\ncontributions:\n  monthly_amount: 100\n")
    inv = api.get(SEPT).json()["investing"]
    assert (inv["strategy_state"], inv["planned"]) == ("invalid", None)


def test_a_partial_strategy_still_gives_its_plan(api):
    _enable_investments(api)
    _write_strategy(
        STRATEGY_PLAN.format(currency="PLN", amount=1500)
        + "rules:\n  - id: broken\n    kind: no_such_kind\n"
    )
    inv = api.get(SEPT).json()["investing"]
    assert inv["strategy_state"] == "partial" and inv["planned"]["amount"] == 1500.0


def test_plan_in_another_currency_uses_that_currency(api):
    _enable_investments(api)
    _write_strategy(STRATEGY_PLAN.format(currency="EUR", amount=100))
    cmp_ = api.get(SEPT).json()["investing"]["comparison"]
    assert cmp_["currency"] == "EUR" and cmp_["surplus"] == -9.99
    assert cmp_["suggested_transfer"] == 0.0 and cmp_["status"] == "short"
    assert cmp_["difference"] == -100.0

    _write_strategy(STRATEGY_PLAN.format(currency="USD", amount=100))
    cmp_ = api.get(SEPT).json()["investing"]["comparison"]
    assert cmp_["has_data"] is False and cmp_["status"] == "short"


# --------------------------------------------------------------------------- #
# Cushion rule
# --------------------------------------------------------------------------- #

def _put(api, cushion: dict, slug: str | None = None):
    base = f"/api/p/{slug}" if slug else "/api"
    return api.put(f"{base}/budget/settings", json={"cushion": cushion})


def test_settings_default_off_and_stored_privately(api, tmp_path):
    assert api.get("/api/budget/settings").json() == {"cushion": {
        "enabled": False, "currency": None, "target_amount": None, "target_months": None,
        "account_ids": [], "monthly_max": None,
    }}
    r = _put(api, {"enabled": True, "target_amount": 30000})
    assert r.status_code == 200 and r.json()["cushion"]["target_amount"] == 30000.0
    path = paths.data_dir() / "profiles" / "default" / "budget.json"
    assert path.is_file() and str(path).startswith(str(tmp_path))
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["cushion"]["enabled"] is True
    assert api.get("/api/budget/settings").json()["cushion"]["enabled"] is True
    # per profile: another profile still has the defaults
    api.post("/api/profiles", json={"name": "Marta", "modules": ["budget"]})
    assert api.get("/api/p/marta/budget/settings").json()["cushion"]["enabled"] is False
    # a corrupt file reads as the defaults
    path.write_text("{not json")
    assert api.get("/api/budget/settings").json()["cushion"]["enabled"] is False


def test_cushion_top_up_comes_before_the_transfer(api):
    # savings "Erste Test" holds 24000 at the end of September
    _put(api, {"enabled": True, "target_amount": 30000})
    close = api.get(SEPT).json()
    c = close["cushion"]
    assert (c["currency"], c["target"], c["target_source"]) == ("PLN", 30000.0, "amount")
    assert (c["balance"], c["missing"], c["top_up"], c["reached"]) == (24000.0, 6000.0, 4724.25, False)
    assert [a["name"] for a in c["accounts"]] == ["Erste Test"]
    pln = _pln(close)
    assert (pln["cushion_top_up"], pln["suggested_transfer"]) == (4724.25, 0.0)

    _put(api, {"enabled": True, "target_amount": 30000, "monthly_max": 1000})
    pln = _pln(api.get(SEPT).json())
    assert (pln["cushion_top_up"], pln["suggested_transfer"]) == (1000.0, 3724.25)

    _put(api, {"enabled": True, "target_amount": 20000})
    close = api.get(SEPT).json()
    assert close["cushion"]["reached"] is True and close["cushion"]["top_up"] == 0.0
    assert _pln(close)["suggested_transfer"] == 4724.25


def test_cushion_and_plan_together(api):
    _enable_investments(api)
    _write_strategy(STRATEGY_PLAN.format(currency="PLN", amount=2000))
    _put(api, {"enabled": True, "target_amount": 30000, "monthly_max": 3000})
    cmp_ = api.get(SEPT).json()["investing"]["comparison"]
    assert cmp_["suggested_transfer"] == 1724.25
    assert cmp_["status"] == "short" and cmp_["difference"] == pytest.approx(-275.75)


def test_cushion_target_in_months_of_spending(api):
    _put(api, {"enabled": True, "target_months": 6})
    flows = [r for r in api.get("/api/cashflow").json() if r["label"] <= "2026-09"][-6:]
    average = round(sum(r["expense"] for r in flows) / len(flows), 2)
    c = api.get(SEPT).json()["cushion"]
    assert c["target_source"] == "months" and c["target_months"] == 6
    assert c["average_spending"] == pytest.approx(average)
    assert c["target"] == pytest.approx(round(average * 6, 2))
    assert c["missing"] == pytest.approx(max(0.0, c["target"] - 24000.0))


def test_cushion_balance_is_taken_at_the_month_end(api):
    _put(api, {"enabled": True, "target_amount": 30000})
    aug = api.get("/api/budget/month-close?month=2026-08").json()
    assert aug["cushion"]["balance"] == 0.0  # the savings balance is first known on 2026-09-30
    assert aug["cushion"]["top_up"] == _pln(aug)["surplus"]


def test_cushion_with_chosen_accounts_and_currency(api):
    main = _account_id("mKonto Test")
    _put(api, {"enabled": True, "target_amount": 6000, "account_ids": [main]})
    c = api.get(SEPT).json()["cushion"]
    # the income account as the cushion (F6 review V7): no balance before September, so its level
    # is the month-end 5000 minus September's income and spending booked on it (9000 - 4235.75)
    assert c["balance"] == 235.75 and [a["id"] for a in c["accounts"]] == [main]

    eur = _account_id("eKonto EUR Test")
    _put(api, {"enabled": True, "currency": "eur", "target_amount": 1000, "account_ids": [eur]})
    close = api.get(SEPT).json()
    # month-end 460.04 without September's 9.99 of spending on it (that is the EUR surplus, V7)
    assert close["cushion"]["currency"] == "EUR" and close["cushion"]["balance"] == 470.03
    assert close["cushion"]["top_up"] == 0.0  # EUR surplus is negative: nothing to set aside
    assert _pln(close)["cushion_top_up"] == 0.0


def test_settings_validation(api):
    main = _account_id("mKonto Test")
    cases = [
        ({"enabled": True}, "an enabled cushion needs target_amount or target_months"),
        ({"enabled": "yes", "target_amount": 1}, "cushion.enabled must be true or false"),
        ({"enabled": True, "target_amount": -5}, "cushion.target_amount must be a positive number"),
        ({"enabled": True, "target_amount": "abc"}, "cushion.target_amount must be a positive number"),
        ({"enabled": True, "target_months": 0}, "cushion.target_months must be a whole number from 1 to 36"),
        ({"enabled": True, "target_months": 2.5}, "cushion.target_months must be a whole number from 1 to 36"),
        ({"enabled": True, "target_amount": 1, "currency": "EURO"},
         "cushion.currency must be a three-letter currency code"),
        ({"enabled": True, "target_amount": 1, "account_ids": ["x"]},
         "cushion.account_ids must be a list of account ids"),
        ({"enabled": True, "target_amount": 1, "account_ids": [999999]}, "unknown account id(s): 999999"),
        ({"enabled": True, "target_amount": 1, "currency": "EUR", "account_ids": [main]},
         "cushion accounts must be in EUR: mKonto Test"),
    ]
    for cushion, detail in cases:
        r = _put(api, cushion)
        assert r.status_code == 422, cushion
        assert r.json()["detail"] == detail
    assert api.get("/api/budget/settings").json()["cushion"]["enabled"] is False


def test_cushion_accounts_of_another_profile_are_refused(api):
    api.post("/api/profiles", json={"name": "Marta", "modules": ["budget"]})
    main = _account_id("mKonto Test")  # owned by the default profile
    r = _put(api, {"enabled": True, "target_amount": 1, "account_ids": [main]}, slug="marta")
    assert r.status_code == 422 and r.json()["detail"] == f"unknown account id(s): {main}"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

@pytest.fixture
def run(monkeypatch):
    from rich.console import Console
    from typer.testing import CliRunner

    from finanse import cli as cli_mod
    from finanse.core import cliutil

    monkeypatch.setattr(cliutil, "console", Console(width=200, color_system=None))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    runner = CliRunner()

    def _run(*args, code=0):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        assert res.exit_code == code, res.output + repr(res.exception)
        return res.output

    return _run


def test_cli_month_close_and_cushion(run, seeded_engine):
    out = run("budget", "month-close", "--month", "2026-09")
    assert "Month close 2026-09" in out and "4 724,25 PLN" in out and "-9,99 EUR" in out
    assert "PLN top spending: Raty kredytów 3 000,00 PLN" in out

    assert "Cushion rule: off" in run("budget", "cushion")
    out = run("budget", "cushion", "--target", "30000", "--monthly-max", "1000")
    assert "Cushion rule: on, target 30000.00" in out
    out = run("budget", "month-close", "--month", "2026-09")
    assert "Cushion: 24 000,00 PLN of 30 000,00 PLN, top-up 1 000,00 PLN" in out
    assert "3 724,25 PLN" in out
    assert "Cushion rule: off" in run("budget", "cushion", "--off")
    run("budget", "month-close", "--month", "2026-9x", code=2)
    run("budget", "cushion", "--months", "99", code=2)
