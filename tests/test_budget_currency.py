"""Budget views for any base currency: a EUR-only household and a mixed PLN + EUR one.

Every budget endpoint defaults to the profile's base currency (no PLN assumption), lists each currency
on its own and never sums currencies. Synthetic data only.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from finanse.core import accounts, profiles
from finanse.db import get_session
from finanse.models import Source
from finanse.modules.budget import service as budget
from finanse.modules.budget.ingestion.normalize import RawTransaction

IBAN_ANNA = "99114000000000000000000901"
IBAN_EMPLOYER_EU = "99102000000000000000000902"
IBAN_LANDLORD = "99105000000000000000000903"


def _raw(d, amount, *, ref, cp=None, iban=None, currency="EUR"):
    return RawTransaction(
        booking_date=d, amount=Decimal(amount), currency=currency, counterparty_name=cp,
        counterparty_iban=iban, reference=ref, description=ref, source=Source.CSV,
    )


def seed_eur_household(profile_id: int) -> None:
    """Three months of a EUR-only household (invented numbers)."""
    with get_session() as s:
        acc = accounts.get_or_create_account(
            s, bank="mbank", iban=IBAN_ANNA, name="Konto EUR Test", currency="EUR",
            profile_id=profile_id,
        )
        rows = []
        for m in (7, 8, 9):
            rows += [
                _raw(date(2026, m, 1), "3200.00", ref=f"GEHALT {m:02d} TEST", iban=IBAN_EMPLOYER_EU),
                _raw(date(2026, m, 3), "-950.00", ref="CZYNSZ", cp="LANDLORD TEST",
                     iban=IBAN_LANDLORD),
                _raw(date(2026, m, 6), f"-{80 + m}.40", ref="BIEDRONKA 123 TEST"),
                _raw(date(2026, m, 20), "-45.00", ref="ORLEN STACJA TEST"),
            ]
        rows.append(_raw(date(2026, 9, 25), "-12.00", ref="SKLEP NIEZNANY EU TEST"))
        budget.ingest_transactions(s, acc, rows, source=Source.CSV)
        budget.categorize_all(s, profile_id=profile_id)


@pytest.fixture
def anna(api_empty):
    r = api_empty.post(
        "/api/profiles", json={"name": "Anna", "base_currency": "EUR", "modules": ["budget"]}
    )
    assert r.status_code == 201
    with get_session() as s:
        pid = profiles.get_by_slug(s, "anna").id
    seed_eur_household(pid)
    return api_empty


def test_eur_only_profile_sees_its_budget_without_a_currency_parameter(anna):
    api = anna
    flows = api.get("/api/p/anna/cashflow").json()
    assert [r["label"] for r in flows] == ["2026-07", "2026-08", "2026-09"]
    assert flows[-1] == {"label": "2026-09", "income": 3200.0, "expense": 1096.4, "net": 2103.6}
    assert api.get("/api/p/anna/cashflow?currency=PLN").json() == []

    spend = {r["category"]: r["amount"] for r in api.get("/api/p/anna/spending?year=2026&month=9").json()}
    assert spend["housing"] == 950.0 and spend["groceries"] == 89.4 and spend["fuel"] == 45.0
    assert sum(spend.values()) == pytest.approx(1096.4)

    drill = api.get("/api/p/anna/category/groceries/transactions").json()
    assert len(drill) == 3 and {r["currency"] for r in drill} == {"EUR"}
    unknown = api.get("/api/p/anna/uncategorized").json()
    assert unknown and {r["currency"] for r in unknown} == {"EUR"}

    # the overview KPI ("Wynik <month>") follows the base currency too
    month = api.get("/api/p/anna/summary").json()["month"]
    assert month == {"label": "2026-09", "income": 3200.0, "expense": 1096.4, "net": 2103.6}


def test_eur_profile_currency_list_and_cash_pool(anna):
    api = anna
    cur = api.get("/api/p/anna/budget/currencies").json()
    assert cur["base"] == "EUR" and cur["default"] == "EUR"
    assert [c["currency"] for c in cur["currencies"]] == ["EUR"]
    assert cur["currencies"][0]["first"] == "2026-07-01"
    assert cur["currencies"][0]["last"] == "2026-09-25"

    assert api.get("/api/p/anna/cash").json()["currency"] == "EUR"
    r = api.post("/api/p/anna/cash/expense",
                 json={"amount": 20, "title": "Markt Test", "category": "groceries"})
    assert r.json()["ok"] is True
    cash = api.get("/api/p/anna/cash").json()
    assert cash["exists"] is True and cash["currency"] == "EUR" and cash["balance"] == -20.0
    pool = [a for a in api.get("/api/p/anna/accounts").json() if a["type"] == "cash"]
    assert [(a["name"], a["currency"]) for a in pool] == [("Gotówka", "EUR")]


def test_eur_profile_month_close(anna):
    close = anna.get("/api/p/anna/budget/month-close?month=2026-09").json()
    assert close["month"] == "2026-09" and close["base_currency"] == "EUR"
    assert close["first_month"] == "2026-07" and close["last_month"] == "2026-09"
    assert close["investing"] is None and close["cushion"] is None
    [eur] = close["currencies"]
    assert eur["currency"] == "EUR"
    assert (eur["income"], eur["spending"], eur["surplus"]) == (3200.0, 1096.4, 2103.6)
    assert eur["suggested_transfer"] == 2103.6 and eur["cushion_top_up"] == 0.0
    assert eur["spending_by_category"][0] == {"category": "housing", "label": "Mieszkanie/Czynsz",
                                              "amount": 950.0}


def test_a_profile_with_only_foreign_data_defaults_to_its_data_currency(api_empty):
    """Base PLN, but the household only has EUR transactions: the picker's default is EUR, the
    endpoints still answer in the base currency unless asked (no silent switch)."""
    api_empty.post("/api/profiles", json={"name": "Jan", "base_currency": "PLN",
                                          "modules": ["budget"]})
    with get_session() as s:
        pid = profiles.get_by_slug(s, "jan").id
    seed_eur_household(pid)
    cur = api_empty.get("/api/p/jan/budget/currencies").json()
    assert cur["base"] == "PLN" and cur["default"] == "EUR"
    assert api_empty.get("/api/p/jan/cashflow").json() == []
    assert len(api_empty.get("/api/p/jan/cashflow?currency=EUR").json()) == 3


def test_mixed_profile_lists_each_currency_on_its_own(api):
    cur = api.get("/api/budget/currencies").json()
    assert cur["base"] == "PLN" and cur["default"] == "PLN"
    assert [c["currency"] for c in cur["currencies"]] == ["PLN", "EUR"]

    pln = api.get("/api/spending").json()
    eur = api.get("/api/spending?currency=EUR").json()
    assert sum(r["amount"] for r in eur) == pytest.approx(39.96)  # 4 x 9.99, nothing from PLN
    assert sum(r["amount"] for r in pln) > 10000 and all(r["amount"] != 9.99 for r in pln)
    assert api.get("/api/cashflow").json() == api.get("/api/cashflow?currency=PLN").json()


def test_mixed_profile_month_close_matches_the_cashflow_and_spending_views(api):
    close = api.get("/api/budget/month-close?month=2026-09").json()
    assert [c["currency"] for c in close["currencies"]] == ["PLN", "EUR"]
    for c in close["currencies"]:
        cur = c["currency"]
        flow = next(r for r in api.get(f"/api/cashflow?currency={cur}").json()
                    if r["label"] == "2026-09")
        assert (c["income"], c["spending"]) == (flow["income"], flow["expense"])
        assert c["surplus"] == pytest.approx(flow["net"])
        spend = api.get(f"/api/spending?year=2026&month=9&currency={cur}").json()
        assert [(r["category"], r["amount"]) for r in c["spending_by_category"]] == [
            (r["category"], r["amount"]) for r in spend
        ]
    pln, eur = close["currencies"]
    # September, PLN: salary 9000; rent 650, installment 3000, groceries 109.50 + 78.25 + 40 (cash),
    # sports club 139, Netflix 43, fuel 209, card fee 7; the savings transfer and the ATM withdrawal
    # moved into the cash pool are not spending.
    assert (pln["income"], pln["spending"], pln["surplus"]) == (9000.0, 4275.75, 4724.25)
    assert (eur["income"], eur["spending"], eur["surplus"]) == (0.0, 9.99, -9.99)
    assert eur["suggested_transfer"] == 0.0  # never below zero
