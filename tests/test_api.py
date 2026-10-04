"""Characterization tests for the JSON API (`/api/*`) on a synthetic seeded DB.

They pin the current response shapes and the key numbers so the wave-2 module
split can move code without changing behaviour. Seed: `conftest.seed_demo`.
Numbers that depend on today's date (loan outstanding, car value) are checked
against the library functions instead of literals.
"""

from datetime import date

import pytest
from sqlmodel import select

from finanse.api.app import app

# Every upstream endpoint. A route disappearing or moving is a behaviour change.
UPSTREAM_ROUTES = {
    ("GET", "/api/summary"),
    ("GET", "/api/networth"),
    ("GET", "/api/networth/series"),
    ("GET", "/api/cashflow"),
    ("GET", "/api/recurring"),
    ("GET", "/api/accounts"),
    ("GET", "/api/categories"),
    ("GET", "/api/spending"),
    ("GET", "/api/uncategorized"),
    ("POST", "/api/merchant-category"),
    ("GET", "/api/category/{key}/transactions"),
    ("POST", "/api/transactions/{txn_id}/category"),
    ("GET", "/api/cash"),
    ("POST", "/api/cash/expense"),
    ("DELETE", "/api/cash/transaction/{txn_id}"),
    ("POST", "/api/resync"),
    ("GET", "/api/loan"),
}

def _today() -> date:
    return date.today()  # noqa: DTZ011 - the code under test uses the naive local date


ACCOUNT_KEYS = {"id", "bank", "name", "type", "currency", "iban_tail", "balance", "as_of", "is_liability"}


def _today_values(seeded_engine):
    """Mortgage outstanding and car value as of today, from the library itself."""
    from sqlmodel import Session

    from finanse.models import Depreciation, Loan
    from finanse.modules.assets.depreciation import value_of
    from finanse.modules.loans import amortization as loanmod

    with Session(seeded_engine) as s:
        ln = s.exec(select(Loan)).one()
        dep = s.exec(select(Depreciation)).one()
        summ = loanmod.summarize(
            ln.principal, ln.annual_rate, ln.term_months, ln.start_date, _today(),
            origination_date=ln.origination_date,
        )
        return float(summ.outstanding), float(round(value_of(dep, _today()), 2))


def api_routes() -> set[tuple[str, str]]:
    """(METHOD, path) of every /api/* route, from the OpenAPI schema (FastAPI keeps
    included routers unflattened in `app.routes`)."""
    return {
        (method.upper(), path)
        for path, ops in app.openapi()["paths"].items()
        if path.startswith("/api/")
        for method in ops
    }


def test_all_upstream_routes_exist():
    assert UPSTREAM_ROUTES <= api_routes()


# --------------------------------------------------------------------------- #
# Read endpoints
# --------------------------------------------------------------------------- #

def test_summary(api, seeded_engine):
    body = api.get("/api/summary").json()
    assert set(body) == {"networth", "breakdown", "month", "subscriptions"}
    mortgage, car = _today_values(seeded_engine)
    pln = 5000 + 24000 + 600000 + 260 + car - mortgage
    assert body["networth"] == {"EUR": 460.04, "PLN": pytest.approx(pln, abs=0.01)}
    assert body["month"] == {"label": "2026-09", "income": 9000.0, "expense": 4275.75, "net": 4724.25}
    # Netflix + sports club (PLN) and Spotify (EUR); totals per currency (B2 fix:
    # before, rent/mortgage/ATM/fee were counted and EUR was added into the PLN sum).
    assert body["subscriptions"] == {
        "count": 3, "monthly_total": 182.0, "monthly_totals": {"EUR": 9.99, "PLN": 182.0},
    }


def test_networth(api, seeded_engine):
    body = api.get("/api/networth").json()
    assert set(body) == {"totals", "breakdown", "accounts"}
    mortgage, car = _today_values(seeded_engine)

    accounts = {a["name"]: a for a in body["accounts"]}
    assert len(accounts) == 7
    assert all(set(a) == ACCOUNT_KEYS for a in body["accounts"])
    assert accounts["mKonto Test"] | {"id": None} == {
        "id": None, "bank": "mbank", "name": "mKonto Test", "type": "checking", "currency": "PLN",
        "iban_tail": "0001", "balance": 5000.0, "as_of": "2026-09-30", "is_liability": False,
    }
    assert accounts["eKonto EUR Test"]["balance"] == 460.04
    assert accounts["Erste Test"]["balance"] == 24000.0
    assert accounts["Mieszkanie Test"]["balance"] == 600000.0
    assert accounts["Mieszkanie Test"]["as_of"] == "2026-06-01"
    assert accounts["Gotówka"]["balance"] == 260.0
    # computed accounts: as of today, mortgage subtracts (but is_liability is only for credit cards)
    assert accounts["Kredyt hipoteczny Test"]["balance"] == pytest.approx(-mortgage)
    assert accounts["Kredyt hipoteczny Test"]["as_of"] == _today().isoformat()
    assert accounts["Kredyt hipoteczny Test"]["is_liability"] is False
    assert accounts["Auto Test"]["balance"] == pytest.approx(car, abs=0.01)

    pln_sum = sum(a["balance"] for a in body["accounts"] if a["currency"] == "PLN")
    assert body["totals"]["PLN"] == pytest.approx(pln_sum, abs=0.01)
    assert body["totals"]["EUR"] == 460.04

    bd = body["breakdown"]
    assert bd["currency"] == "PLN"
    assert bd["property"] == 600000.0
    assert bd["mortgage"] == pytest.approx(mortgage)
    assert bd["home_equity"] == pytest.approx(600000 - mortgage)
    assert bd["assets"] == pytest.approx(5000 + 24000 + 600000 + 260 + car, abs=0.01)
    assert bd["liabilities"] == pytest.approx(mortgage)
    assert bd["net"] == pytest.approx(body["totals"]["PLN"], abs=0.01)
    assert set(bd["by_type"]) == {"checking", "savings", "property", "mortgage", "vehicle", "cash"}
    assert bd["by_type"]["checking"] == 5000.0  # PLN only (the EUR account is not mixed in)


def test_networth_series_daily(api):
    body = api.get("/api/networth/series").json()
    assert [p["date"] for p in body["points"]] == ["2026-06-01", "2026-09-15", "2026-09-16", "2026-09-30"]
    assert [c["key"] for c in body["components"]] == ["money", "property", "vehicle", "mortgage"]
    assert body["components"][3] == {"key": "mortgage", "label": "Hipoteka", "liability": True}
    for p in body["points"]:
        assert p["value"] == pytest.approx(sum(p["components"].values()), abs=0.01)


def test_networth_series_monthly(api):
    body = api.get("/api/networth/series", params={"granularity": "monthly"}).json()
    assert body["points"] == [
        {"date": "2026-06-01", "value": 277291.01,
         "components": {"property": 600000.0, "vehicle": 67075.94, "mortgage": -389784.93}},
        {"date": "2026-09-30", "value": 305567.25,
         "components": {"money": 29260.0, "property": 600000.0, "vehicle": 63560.12,
                        "mortgage": -387252.87}},
    ]


def test_networth_series_liquid_and_other_currency(api):
    liquid = api.get("/api/networth/series", params={"granularity": "monthly", "scope": "liquid"}).json()
    assert liquid == {
        "currency": "PLN",  # additive (R-04): the series names its currency
        "points": [{"date": "2026-09-30", "value": 29260.0, "components": {"money": 29260.0}}],
        "components": [{"key": "money", "label": "Pieniądze", "liability": False}],
    }
    eur = api.get("/api/networth/series", params={"currency": "EUR"}).json()
    assert eur["points"] == [{"date": "2026-09-30", "value": 460.04, "components": {"money": 460.04}}]


def test_cashflow(api):
    rows = api.get("/api/cashflow").json()
    assert rows == [
        {"label": "2026-06", "income": 9000.0, "expense": 4523.75, "net": 4476.25},
        {"label": "2026-07", "income": 9000.0, "expense": 4527.75, "net": 4472.25},
        {"label": "2026-08", "income": 9000.0, "expense": 4586.75, "net": 4413.25},
        {"label": "2026-09", "income": 9000.0, "expense": 4275.75, "net": 4724.25},
    ]
    assert [r["label"] for r in api.get("/api/cashflow", params={"months": 2}).json()] == [
        "2026-08", "2026-09",
    ]
    eur = api.get("/api/cashflow", params={"currency": "EUR"}).json()
    assert eur[0] == {"label": "2026-06", "income": 500.0, "expense": 9.99, "net": 490.01}


def test_recurring(api):
    items = api.get("/api/recurring").json()["items"]
    assert all(
        set(i) == {"payee", "amount", "currency", "count", "gap_days", "last", "active"}
        for i in items
    )
    by_payee = {i["payee"]: i for i in items}
    # Rent, the mortgage installment, the ATM withdrawal and the card fee are not
    # listed (B2 fix).
    assert set(by_payee) == {"SPOTIFY TEST", "NETFLIX.COM", "KLUB SPORTOWY TEST"}
    assert by_payee["NETFLIX.COM"] == {
        "payee": "NETFLIX.COM", "amount": 43.0, "currency": "PLN", "count": 4, "gap_days": 31,
        "last": "2026-09-07", "active": True,
    }
    assert by_payee["SPOTIFY TEST"]["currency"] == "EUR"
    assert [i["last"] for i in items] == sorted((i["last"] for i in items), reverse=True)


def test_accounts(api):
    rows = api.get("/api/accounts").json()
    assert len(rows) == 7
    assert all(set(r) == ACCOUNT_KEYS | {"active"} for r in rows)
    assert all(r["balance"] is None and r["as_of"] is None and r["active"] for r in rows)
    assert [r["type"] for r in rows] == [
        "checking", "checking", "savings", "property", "mortgage", "vehicle", "cash",
    ]


def test_categories(api):
    rows = api.get("/api/categories").json()
    assert len(rows) == 25
    assert rows[0] == {"key": "groceries", "label": "Spożywcze", "kind": "expense"}
    assert rows[6] == {"key": "loans", "label": "Raty kredytów", "kind": "expense"}  # B2
    assert rows[-1] == {"key": "cash_withdrawal", "label": "Wypłata gotówki", "kind": "transfer"}
    kinds = {r["kind"] for r in rows}
    assert kinds == {"expense", "income", "transfer"}


def test_spending_all_time(api):
    rows = api.get("/api/spending").json()
    assert rows == [
        {"category": "loans", "label": "Raty kredytów", "amount": 12000.0},  # B2: was Subskrypcje
        {"category": "housing", "label": "Mieszkanie/Czynsz", "amount": 2600.0},
        {"category": "cash", "label": "Gotówka", "amount": 900.0},
        {"category": "fuel", "label": "Paliwo", "amount": 830.0},
        {"category": "groceries", "label": "Spożywcze", "amount": 773.0},
        {"category": "subscriptions", "label": "Subskrypcje", "amount": 728.0},
        {"category": "other", "label": "Inne", "amount": 55.0},
        {"category": "fees", "label": "Opłaty bankowe", "amount": 28.0},
    ]


def test_spending_periods(api):
    sep = api.get("/api/spending", params={"year": 2026, "month": 9}).json()
    assert {r["category"]: r["amount"] for r in sep} == {
        "loans": 3000.0, "subscriptions": 182.0, "housing": 650.0, "groceries": 227.75,
        "fuel": 209.0, "fees": 7.0,
    }
    q3 = api.get("/api/spending", params={"year": 2026, "quarter": 3}).json()
    assert {r["category"]: r["amount"] for r in q3}["housing"] == 1950.0
    eur = api.get("/api/spending", params={"currency": "EUR"}).json()
    assert eur == [{"category": "subscriptions", "label": "Subskrypcje", "amount": 39.96}]


def test_uncategorized(api):
    assert api.get("/api/uncategorized").json() == [
        {"merchant_key": "SKLEP NIEZNANY TEST", "sample": "SKLEP NIEZNANY TEST",
         "count": 1, "total": 55.0, "currency": "PLN"},
    ]
    assert api.get("/api/uncategorized", params={"currency": "EUR"}).json() == []


def test_category_transactions(api):
    rows = api.get(
        "/api/category/groceries/transactions",
        params={"year": 2026, "month": 9, "sort": "amount"},
    ).json()
    assert [(r["date"], r["amount"], r["merchant"], r["account"]) for r in rows] == [
        ("2026-09-06", -109.5, "BIEDRONKA 123 TEST", "mKonto Test"),
        ("2026-09-20", -78.25, "BIEDRONKA 123 TEST", "mKonto Test"),
        ("2026-09-16", -40.0, "Targ Test", "Gotówka"),
    ]
    assert set(rows[0]) == {
        "id", "date", "amount", "currency", "merchant", "merchant_key", "details",
        "counterparty", "category", "category_source", "account",
    }
    assert rows[0]["category_source"] == "keyword"
    assert rows[0]["details"] == "ZAKUP PRZY UZYCIU KARTY"
    assert rows[2]["category_source"] == "manual_txn"

    by_date = api.get(
        "/api/category/groceries/transactions",
        params={"year": 2026, "month": 9, "order": "asc"},
    ).json()
    assert [r["date"] for r in by_date] == ["2026-09-06", "2026-09-16", "2026-09-20"]


def test_cash(api):
    body = api.get("/api/cash").json()
    assert {k: body[k] for k in ("exists", "currency", "balance", "withdrawals", "expenses")} == {
        "exists": True, "currency": "PLN", "balance": 260.0, "withdrawals": 300.0, "expenses": 40.0,
    }
    assert [(t["date"], t["amount"], t["title"], t["kind"], t["category_label"])
            for t in body["transactions"]] == [
        ("2026-09-16", -40.0, "Targ Test", "expense", "Spożywcze"),
        ("2026-09-15", 300.0, "Wypłata gotówki", "withdrawal", "Wypłata gotówki"),
    ]
    assert api.get("/api/cash", params={"currency": "EUR"}).json() == {
        "exists": False, "currency": "EUR", "balance": 0.0, "withdrawals": 0.0,
        "expenses": 0.0, "transactions": [],
    }


def test_loan(api, seeded_engine):
    body = api.get("/api/loan").json()
    mortgage, _car = _today_values(seeded_engine)
    assert body["has_loan"] is True
    assert {k: body[k] for k in (
        "currency", "principal", "annual_rate", "term_months", "monthly_payment",
        "start_date", "total_interest", "payoff_date",
    )} == {
        "currency": "PLN", "principal": 400000.0, "annual_rate": 6.0, "term_months": 300,
        "monthly_payment": 2577.21, "start_date": "2025-01-05", "total_interest": 373159.82,
        "payoff_date": "2049-12-05",
    }
    assert body["outstanding"] == pytest.approx(mortgage)
    assert len(body["schedule"]) == 300 and len(body["series"]) == 300
    assert body["schedule"][0] == {
        "n": 1, "date": "2025-01-05", "payment": 2577.21, "interest": 2000.0,
        "principal": 577.21, "balance": 399422.79,
    }
    assert body["series"][0] == {"date": "2025-01-05", "balance": 399422.79}
    assert {"months_elapsed", "paid_principal", "paid_interest", "remaining_interest"} <= set(body)


def test_empty_db_reads(api_empty):
    assert api_empty.get("/api/loan").json() == {"has_loan": False}
    assert api_empty.get("/api/recurring").json() == {"items": []}
    assert api_empty.get("/api/cashflow").json() == []
    assert api_empty.get("/api/networth/series").json() == {
        "currency": "PLN", "points": [], "components": [],
    }
    summary = api_empty.get("/api/summary").json()
    assert summary["networth"] == {}
    assert summary["month"] is None
    assert summary["subscriptions"] == {"count": 0, "monthly_total": 0.0, "monthly_totals": {}}


def test_index_serves_html(api):
    r = api.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


# --------------------------------------------------------------------------- #
# Write endpoints
# --------------------------------------------------------------------------- #

def test_merchant_category(api):
    r = api.post("/api/merchant-category",
                 json={"merchant_key": "SKLEP NIEZNANY TEST", "category": "shopping"})
    assert r.json() == {"updated": 1}
    assert api.get("/api/uncategorized").json() == []
    spend = {x["category"]: x["amount"] for x in api.get("/api/spending").json()}
    assert spend["shopping"] == 55.0 and "other" not in spend
    # invalid input is a 200 with an error body (upstream convention)
    bad = api.post("/api/merchant-category", json={"merchant_key": "X", "category": "nope"})
    assert bad.status_code == 200 and bad.json() == {"error": "invalid merchant_key or category"}


def test_transaction_category(api):
    rows = api.get("/api/category/fuel/transactions", params={"year": 2026, "month": 9}).json()
    txn_id = rows[0]["id"]
    assert api.post(f"/api/transactions/{txn_id}/category", json={"category": "car"}).json() == {"ok": True}
    car = api.get("/api/category/car/transactions").json()
    assert [(r["id"], r["category_source"]) for r in car] == [(txn_id, "manual_txn")]
    assert api.post("/api/transactions/999999/category", json={"category": "car"}).json() == {"ok": False}
    assert api.post(f"/api/transactions/{txn_id}/category", json={"category": "x"}).json() == {
        "error": "invalid category"
    }


def test_transaction_category_cash_withdrawal_creates_cash_leg(api):
    rows = api.get("/api/category/cash/transactions", params={"year": 2026, "month": 8}).json()
    assert api.post(f"/api/transactions/{rows[0]['id']}/category",
                    json={"category": "cash_withdrawal"}).json() == {"ok": True}
    cash = api.get("/api/cash").json()
    assert cash["balance"] == 560.0 and cash["withdrawals"] == 600.0


def test_cash_expense_add_and_delete(api):
    r = api.post("/api/cash/expense", json={
        "amount": 12.5, "title": "Kawa Test", "category": "dining", "date": "2026-09-20",
    }).json()
    assert r["ok"] is True and isinstance(r["id"], int)
    cash = api.get("/api/cash").json()
    assert cash["balance"] == 247.5
    assert cash["transactions"][0]["title"] == "Kawa Test"

    assert api.delete(f"/api/cash/transaction/{r['id']}").json() == {"ok": True}
    assert api.get("/api/cash").json()["balance"] == 260.0
    # only cash-pool rows are deletable
    bank_row = api.get("/api/category/fuel/transactions").json()[0]["id"]
    assert api.delete(f"/api/cash/transaction/{bank_row}").json() == {"ok": False}


def test_cash_withdrawal_leg_delete_reverts_bank_txn(api):
    leg = next(t for t in api.get("/api/cash").json()["transactions"] if t["kind"] == "withdrawal")
    assert api.delete(f"/api/cash/transaction/{leg['id']}").json() == {"ok": True}
    sep = {x["category"]: x["amount"] for x in
           api.get("/api/spending", params={"year": 2026, "month": 9}).json()}
    assert sep["cash"] == 300.0  # the ATM withdrawal is an expense again


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        ({"amount": "abc", "title": "t", "category": "dining"}, "invalid amount"),
        ({"amount": None, "title": "t", "category": "dining"}, "invalid amount"),
        ({"amount": 0, "title": "t", "category": "dining"}, "amount must be positive"),
        ({"amount": 5, "title": "  ", "category": "dining"}, "title required"),
        ({"amount": 5, "title": "t", "category": "nope"}, "invalid category"),
        ({"amount": 5, "title": "t", "category": "dining", "date": "2026-13-01"}, "invalid date"),
    ],
)
def test_cash_expense_validation(api, payload, error):
    r = api.post("/api/cash/expense", json=payload)
    assert r.status_code == 200 and r.json() == {"error": error}


# --------------------------------------------------------------------------- #
# /api/resync (Enable Banking stubbed, no network)
# --------------------------------------------------------------------------- #

def test_resync_not_configured(api, monkeypatch):
    from finanse.config import settings

    monkeypatch.setattr(type(settings), "eb_configured", property(lambda self: False))
    assert api.post("/api/resync").json() == {
        "ok": False, "error": "Enable Banking nie jest skonfigurowany (.env).",
    }


def test_resync_no_sessions(api, eb_configured, fake_eb):
    eb_configured(fake_eb({}), {})
    assert api.post("/api/resync").json() == {
        "ok": False, "error": "Brak zapisanych sesji — zaloguj się: finanse eb login.",
    }


def test_resync_ok(api, eb_configured, fake_eb, make_eb_txn):
    client = fake_eb({
        "sess-1": {
            "aspsp": {"name": "mBank"},
            "accounts": [{"uid": "uid-main", "account_id": {"iban": "PL" + "99114000000000000000000001"},
                          "currency": "PLN"}],
            "transactions": {"uid-main": [
                make_eb_txn("2026-10-01", "25.00", "BIEDRONKA 123 TEST", ref="eb-1"),
                make_eb_txn("2026-10-02", "43.00", "NETFLIX.COM", ref="eb-2"),
            ]},
            "balances": {"uid-main": [{"balance_amount": {"amount": "4932.00", "currency": "PLN"},
                                       "balance_type": "CLBD", "reference_date": "2026-10-02"}]},
        },
    })
    eb_configured(client, {"mbank": "sess-1"})
    body = api.post("/api/resync").json()
    assert body == {
        "ok": True, "inserted": 2, "banks": [{"bank": "mbank", "inserted": 2, "accounts": 1}],
        "pairs": 0, "errors": [],
    }
    accounts = {a["name"]: a for a in api.get("/api/networth").json()["accounts"]}
    assert accounts["mKonto Test"]["balance"] == 4932.0
    assert accounts["mKonto Test"]["as_of"] == "2026-10-02"
    groceries = api.get("/api/category/groceries/transactions", params={"month": 10}).json()
    assert [r["amount"] for r in groceries] == [-25.0]


def test_resync_expired_session_is_reported(api, eb_configured, fake_eb):
    from finanse.modules.budget.ingestion.enable_banking.client import EnableBankingError

    class Expired(fake_eb):
        def get_session(self, session_id):
            raise EnableBankingError("401 session expired")

    eb_configured(Expired({}), {"erste": "sess-old"})
    body = api.post("/api/resync").json()
    assert body["ok"] is True and body["inserted"] == 0 and body["banks"] == []
    assert body["errors"] == ["erste: 401 session expired"]
