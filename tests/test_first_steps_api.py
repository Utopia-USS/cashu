"""First steps for budget, loans and assets (F10, design note section 15): optional setup steps and the
state, the setup response's ``cli_prefix``, budget / loans / assets steps, ``POST /loans``,
``PATCH /loans/{id}/payment`` (with the L3 check), vehicles in ``/assets/manual``. Synthetic data."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlmodel import select

from finanse.core import profiles
from finanse.core.accounts import get_or_create_account
from finanse.core.db import get_session
from finanse.core.models import Account, Source
from finanse.core.modules import PaymentPattern, SetupStatus, SetupStep
from finanse.modules.assets.models import Depreciation
from finanse.modules.budget import service
from finanse.modules.budget.categorize import engine
from finanse.modules.budget.ingestion.normalize import RawTransaction
from finanse.modules.budget.models import Transaction
from finanse.modules.loans.models import Loan

LENDER = "99160000000000000000000555"


def code(resp) -> str | None:
    return resp.headers.get("x-finanse-error-code")


def make(client, name: str, modules: list[str]) -> str:
    r = client.post("/api/profiles", json={"name": name, "modules": modules})
    assert r.status_code in (200, 201), r.text
    return r.json()["slug"]


def setup(client, slug: str, module: str) -> dict:
    return client.get(f"/api/p/{slug}/modules/{module}/setup").json()


# --- core: optional steps -------------------------------------------------------------------------


def _steps(*specs) -> SetupStatus:
    return SetupStatus(steps=tuple(
        SetupStep(f"s{i}", "t", "d", done=done, optional=optional)
        for i, (done, optional) in enumerate(specs)
    ))


def test_optional_steps_never_count_and_are_never_current():
    assert _steps((False, False), (False, True)).state == "empty"
    assert _steps((True, False), (False, True)).state == "ready"
    assert _steps((False, False), (True, True)).state == "empty"  # a done optional step: still empty
    assert _steps((True, False), (False, False), (False, True)).state == "partial"
    status = _steps((False, True), (False, False), (False, False))
    assert [d["status"] for d in status.step_dicts()] == ["todo", "on", "todo"]
    assert [d["optional"] for d in status.step_dicts()] == [True, False, False]


def test_setup_response_carries_the_cli_prefix(api_empty):
    slug = make(api_empty, "Jan", ["budget"])
    assert setup(api_empty, slug, "budget")["cli_prefix"] == f"finanse --profile {slug}"


# --- budget steps (B1) ------------------------------------------------------------------------------


def _ingest(slug: str, bank: str, iban: str, rows: list[tuple[str, str]]) -> None:
    with get_session() as s:
        pid = profiles.get_by_slug(s, slug).id
        acc = get_or_create_account(s, bank=bank, iban=iban, profile_id=pid)
        raws = [
            RawTransaction(booking_date=date(2026, 9, 3), amount=Decimal(a), reference=ref,
                           source=Source.CSV)
            for a, ref in rows
        ]
        service.ingest_transactions(s, acc, raws, source=Source.CSV)
        service.categorize_all(s, profile_id=pid)


def test_budget_steps(api_empty):
    slug = make(api_empty, "Jan", ["budget"])
    body = setup(api_empty, slug, "budget")
    assert [(s["id"], s["title"], s["status"]) for s in body["steps"]] == [
        ("statement", "Pierwszy wyciąg z banku", "on"),
        ("categories", "Kategorie wydatków", "todo"),
        ("transfers", "Przelewy między kontami", "todo"),
    ]
    statement = body["steps"][0]
    assert statement["description"] == "Plik CSV (mBank, Pekao, Erste) albo Open Banking."
    assert [a["target"] for a in statement["actions"]] == [
        f"finanse --profile {slug} import-csv WYCIAG.csv", f'finanse --profile {slug} eb login "mBank"',
    ]
    assert body["steps"][2]["description"] == "Po IBAN między Twoimi kontami; nie liczą się jako wydatki."

    _ingest(slug, "mbank", "99114000000000000000000101", [("-55.00", "SKLEP NIEZNANY TEST")])
    body = setup(api_empty, slug, "budget")
    assert body["state"] == "partial"
    by_id = {s["id"]: s for s in body["steps"]}
    assert by_id["statement"]["status"] == "done" and by_id["categories"]["status"] == "on"
    assert by_id["transfers"]["status"] == "done"  # one bank account: nothing to pair
    assert by_id["transfers"]["description"] == "Jedno konto bankowe: nic do dopasowania."


# --- loans ------------------------------------------------------------------------------------------

LOAN = {
    "name": "Hipoteka", "type": "mortgage", "principal": 400000, "annual_rate": 6.5,
    "term_months": 300, "start_date": "2025-01-05",
}


def test_loans_payment_step_needs_the_budget_module(api_empty):
    alone = make(api_empty, "Ola", ["loans"])
    assert [s["id"] for s in setup(api_empty, alone, "loans")["steps"]] == ["loan"]
    both = make(api_empty, "Jan", ["budget", "loans"])
    body = setup(api_empty, both, "loans")
    assert [(s["id"], s["title"]) for s in body["steps"]] == [
        ("loan", "Kredyt"), ("payments", "Rozpoznawanie rat"),
    ]
    assert api_empty.post(f"/api/p/{alone}/loans", json=LOAN).status_code == 201
    assert setup(api_empty, alone, "loans")["state"] == "ready"
    assert api_empty.post(f"/api/p/{both}/loans", json=LOAN).status_code == 201
    assert setup(api_empty, both, "loans")["state"] == "partial"


def test_create_loan(api_empty):
    slug = make(api_empty, "Jan", ["loans"])
    r = api_empty.post(f"/api/p/{slug}/loans", json={**LOAN, "origination_date": "2024-12-10"})
    assert r.status_code == 201, r.text
    loan = r.json()
    assert loan == api_empty.get(f"/api/p/{slug}/loans").json()[0]  # one GET /loans item
    assert (loan["name"], loan["type"], loan["currency"]) == ("Hipoteka", "mortgage", "PLN")
    assert loan["principal"] == 400000 and loan["annual_rate"] == 6.5 and loan["term_months"] == 300
    assert round(loan["monthly_payment"], 2) == 2700.83  # the note says 2 700,90: a typo
    assert loan["payment_text"] is None and loan["payment_iban_tail"] is None
    again = api_empty.post(f"/api/p/{slug}/loans", json={**LOAN, "name": " Hipoteka "})
    assert again.status_code == 409 and code(again) == "loan_name_taken"
    second = api_empty.post(f"/api/p/{slug}/loans", json={**LOAN, "name": "Auto", "type": "loan",
                                                         "currency": "eur", "annual_rate": 0})
    assert second.status_code == 201 and second.json()["currency"] == "EUR"


@pytest.mark.parametrize(
    "patch",
    [
        {"name": " "}, {"type": "property"}, {"principal": 0}, {"annual_rate": 101},
        {"annual_rate": -1}, {"term_months": 0}, {"term_months": 601},
        {"origination_date": "2025-02-01"}, {"currency": "zloty"},
    ],
)
def test_create_loan_refusals(api_empty, patch):
    slug = make(api_empty, "Jan", ["loans"])
    r = api_empty.post(f"/api/p/{slug}/loans", json={**LOAN, **patch})
    assert r.status_code == 422 and code(r) == "loan_invalid", r.text
    assert api_empty.get(f"/api/p/{slug}/loans").json() == []


def test_create_loan_refuses_a_name_held_by_another_position(api_empty):
    slug = make(api_empty, "Jan", ["loans", "assets"])
    api_empty.post(f"/api/p/{slug}/assets/manual", json={"name": "Dom", "type": "property", "value": 1})
    r = api_empty.post(f"/api/p/{slug}/loans", json={**LOAN, "name": "Dom"})
    assert r.status_code == 422 and code(r) == "loan_invalid"


def _installments(slug: str) -> None:
    """Three months of installments to a lender whose title says nothing about a loan."""
    with get_session() as s:
        pid = profiles.get_by_slug(s, slug).id
        acc = get_or_create_account(s, bank="mbank", iban="99114000000000000000000101", profile_id=pid)
        raws = [
            RawTransaction(booking_date=date(2026, m, 5), amount=Decimal("-2700.90"),
                           counterparty_name="BANK HIPOTECZNY TEST", counterparty_iban=LENDER,
                           reference=f"UMOWA 12/34 {m:02d}", source=Source.CSV)
            for m in (7, 8, 9)
        ] + [RawTransaction(booking_date=date(2026, 9, 6), amount=Decimal("-30.00"),
                            reference="KAWIARNIA TEST", source=Source.CSV)]
        service.ingest_transactions(s, acc, raws, source=Source.CSV)
        service.categorize_all(s, profile_id=pid)


def test_payment_matching_by_phrase_and_iban(api_empty):
    slug = make(api_empty, "Jan", ["budget", "loans"])
    loan = api_empty.post(f"/api/p/{slug}/loans", json=LOAN).json()
    _installments(slug)
    url = f"/api/p/{slug}/loans/{loan['id']}/payment"
    # The phrase comes from the counterparty name (the drawer's candidates fill the recurring payee).
    r = api_empty.patch(url, json={"text": "bank hipoteczny test"})
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 3 and r.json()["loan"]["payment_text"] == "bank hipoteczny test"
    with get_session() as s:
        cats = {t.reference: t.category for t in s.exec(select(Transaction)).all()}
    assert cats["UMOWA 12/34 09"] == "loans" and cats["KAWIARNIA TEST"] != "loans"
    assert setup(api_empty, slug, "loans")["state"] == "ready"
    # Clearing the phrase, then the lender's account number instead; the full number never comes back.
    assert api_empty.patch(url, json={"text": ""}).json()["loan"]["payment_text"] is None
    r = api_empty.patch(url, json={"iban": "PL " + LENDER, "text": None}).json()
    assert r["matched"] == 3 and r["loan"]["payment_iban_tail"] == LENDER[-4:]
    assert LENDER not in str(r)
    assert api_empty.patch(url, json={"iban": None}).json()["loan"]["payment_iban_tail"] is None


def test_payment_refusals_and_profile_scope(api_empty):
    slug = make(api_empty, "Jan", ["budget", "loans"])
    other = make(api_empty, "Ola", ["loans"])
    loan = api_empty.post(f"/api/p/{slug}/loans", json=LOAN).json()
    url = f"/api/p/{slug}/loans/{loan['id']}/payment"
    assert code(api_empty.patch(url, json={})) == "loan_invalid"
    assert code(api_empty.patch(url, json={"iban": "12"})) == "loan_invalid"
    assert code(api_empty.patch(url, json={"text": "x" * 201})) == "loan_invalid"
    r = api_empty.patch(f"/api/p/{other}/loans/{loan['id']}/payment", json={"text": "RATA"})
    assert r.status_code == 404 and code(r) == "not_found"
    assert api_empty.patch(f"/api/p/{slug}/loans/999999/payment", json={"text": "x"}).status_code == 404


def test_payment_without_the_budget_module_matches_nothing(api_empty):
    slug = make(api_empty, "Ola", ["loans"])
    loan = api_empty.post(f"/api/p/{slug}/loans", json=LOAN).json()
    r = api_empty.patch(f"/api/p/{slug}/loans/{loan['id']}/payment", json={"text": "RATA"})
    assert r.status_code == 200 and r.json()["matched"] == 0
    with get_session() as s:
        assert s.get(Loan, loan["id"]).payment_text == "RATA"


def test_l3_phrase_is_matched_against_the_counterparty_name_too():
    """Architect check L3: the loan phrase is matched against the normalized reference, description
    AND counterparty name (categorize/engine.py), so a recurring payee works as the phrase."""
    txn = Transaction(
        account_id=1, booking_date=date(2026, 9, 5), amount=Decimal("-2700.90"),
        counterparty_name="Bank Hipoteczny Łódź", reference="UMOWA 12/34", source=Source.CSV,
        dedup_hash="x",
    )
    pattern = PaymentPattern("loans", text="BANK HIPOTECZNY LODZ")
    assert engine.categorize(txn, own_ibans=set(), rules={}, subscription_keys=set(),
                             patterns=[pattern]) == ("loans", "keyword")


# --- assets ------------------------------------------------------------------------------------------

CAR = {"purchase_price": 80000, "purchase_date": "2025-05-01", "annual_rate": 0.15, "floor": None}


def test_assets_vehicle_step_is_optional(api_empty):
    slug = make(api_empty, "Jan", ["assets"])
    body = setup(api_empty, slug, "assets")
    assert [(s["id"], s["title"], s["optional"], s["status"]) for s in body["steps"]] == [
        ("position", "Pozycja", False, "on"), ("vehicle", "Auto", True, "todo"),
    ]
    assert body["steps"][1]["description"] == "Cena i data zakupu, roczny spadek; wartość liczy się sama."
    api_empty.post(f"/api/p/{slug}/assets/manual", json={"name": "Dom", "type": "property", "value": 5})
    body = setup(api_empty, slug, "assets")
    assert body["state"] == "ready" and [s["status"] for s in body["steps"]] == ["done", "todo"]
    api_empty.post(f"/api/p/{slug}/assets/manual",
                   json={"name": "Auto", "type": "vehicle", "depreciation": CAR})
    assert [s["status"] for s in setup(api_empty, slug, "assets")["steps"]] == ["done", "done"]


def test_create_a_vehicle(api_empty):
    slug = make(api_empty, "Jan", ["assets"])
    r = api_empty.post(f"/api/p/{slug}/assets/manual", json={
        "name": "Auto", "type": "vehicle", "value": 1, "note": "kombi",
        "depreciation": {**CAR, "floor": 20000},
    })
    assert r.status_code == 201, r.text
    row = r.json()
    assert (row["kind"], row["type"], row["note"]) == ("vehicle", "vehicle", "kombi")
    assert row["depreciation"] == {
        "purchase_price": 80000.0, "purchase_date": "2025-05-01", "annual_rate": 0.15, "floor": 20000.0,
    }
    assert 20000 < row["balance"] < 80000  # the curve, not the ignored value
    assert row in api_empty.get(f"/api/p/{slug}/assets/manual").json()
    with get_session() as s:
        assert s.get(Depreciation, 1).annual_rate == Decimal(15)  # stored as a percentage
    for name in ("Auto", " auto ".strip().capitalize()):
        dup = api_empty.post(f"/api/p/{slug}/assets/manual",
                             json={"name": name, "type": "vehicle", "depreciation": CAR})
        assert dup.status_code == 409 and code(dup) == "name_taken"
    # a position and a vehicle never share a name either way
    dup = api_empty.post(f"/api/p/{slug}/assets/manual", json={"name": "Auto", "type": "other", "value": 1})
    assert dup.status_code == 409


@pytest.mark.parametrize(
    "curve",
    [
        None, {}, {**CAR, "purchase_price": 0}, {**CAR, "annual_rate": 1.5}, {**CAR, "annual_rate": -0.1},
        {**CAR, "purchase_date": (date.today() + timedelta(days=1)).isoformat()},  # noqa: DTZ011
        {**CAR, "floor": 90000},
    ],
)
def test_vehicle_refusals(api_empty, curve):
    slug = make(api_empty, "Jan", ["assets"])
    body = {"name": "Auto", "type": "vehicle"} | ({} if curve is None else {"depreciation": curve})
    r = api_empty.post(f"/api/p/{slug}/assets/manual", json=body)
    assert r.status_code == 422 and code(r) == "depreciation_invalid", r.text
    assert api_empty.get(f"/api/p/{slug}/assets/manual").json() == []


def test_a_manual_position_still_needs_a_value(api_empty):
    slug = make(api_empty, "Jan", ["assets"])
    r = api_empty.post(f"/api/p/{slug}/assets/manual", json={"name": "Dom", "type": "property"})
    assert r.status_code == 422


def test_patch_the_depreciation_curve(api_empty):
    slug = make(api_empty, "Jan", ["assets"])
    row = api_empty.post(f"/api/p/{slug}/assets/manual",
                         json={"name": "Auto", "type": "vehicle", "depreciation": CAR}).json()
    url = f"/api/p/{slug}/assets/manual/{row['id']}"
    r = api_empty.patch(url, json={"depreciation": {"annual_rate": 0.2}})
    assert r.status_code == 200, r.text
    assert r.json()["depreciation"] == {**CAR, "purchase_price": 80000.0, "annual_rate": 0.2}
    assert r.json()["balance"] < row["balance"]
    r = api_empty.patch(url, json={"depreciation": {"floor": 50000}, "note": "x"}).json()
    assert r["depreciation"]["floor"] == 50000.0 and r["depreciation"]["annual_rate"] == 0.2
    assert r["note"] == "x"
    r = api_empty.patch(url, json={"depreciation": {"floor": None}}).json()
    assert r["depreciation"]["floor"] is None
    bad = api_empty.patch(url, json={"depreciation": {"purchase_price": -1}})
    assert bad.status_code == 422 and code(bad) == "depreciation_invalid"
    with get_session() as s:
        assert len(s.exec(select(Account).where(Account.type == "vehicle")).all()) == 1
    house = api_empty.post(f"/api/p/{slug}/assets/manual",
                           json={"name": "Dom", "type": "property", "value": 5}).json()
    r = api_empty.patch(f"/api/p/{slug}/assets/manual/{house['id']}", json={"depreciation": CAR})
    assert r.status_code == 422 and "no depreciation" in r.json()["detail"]
    other = make(api_empty, "Ola", ["assets"])
    assert api_empty.patch(f"/api/p/{other}/assets/manual/{row['id']}",
                           json={"depreciation": CAR}).status_code == 404
