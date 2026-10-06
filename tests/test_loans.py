"""Many loans per profile, installment recognition, recorded balances vs the schedule."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from sqlmodel import select

from cashu.core import profiles
from cashu.core.accounts import get_or_create_account, set_balance
from cashu.core.db import get_session
from cashu.core.networth import net_worth, net_worth_series
from cashu.models import Source, Transaction
from cashu.modules.assets.service import add_manual_position
from cashu.modules.budget.analytics import detect_recurring
from cashu.modules.budget.ingestion.normalize import RawTransaction
from cashu.modules.budget.service import categorize_all, ingest_transactions
from cashu.modules.loans import amortization
from cashu.modules.loans.service import add_loan, list_loans, set_loan, set_payment_matching

TODAY = dt.date.today()  # noqa: DTZ011 - the code under test uses the naive local date
LENDER = "99160000000000000000000999"


def _schedule_outstanding(principal, rate, months, start, origination=None) -> Decimal:
    rows = amortization.schedule(Decimal(principal), Decimal(rate), months, start)
    return amortization.outstanding(rows, TODAY, origination)


def _two_loans(session, profile_id=None):
    home = add_loan(
        session, name="Hipoteka Test", type="mortgage", principal="400000", annual_rate="6.0",
        term_months=300, start_date=dt.date(2025, 1, 5), profile_id=profile_id,
    )
    car = add_loan(
        session, name="Auto Test", principal="60000", annual_rate="9.0", term_months=72,
        start_date=dt.date(2025, 3, 1), payment_iban=LENDER, profile_id=profile_id,
    )
    return home, car


def test_many_loans_count_in_net_worth(session):
    _two_loans(session)
    totals, lines = net_worth(session)
    expected = _schedule_outstanding("400000", "6.0", 300, dt.date(2025, 1, 5)) + \
        _schedule_outstanding("60000", "9.0", 72, dt.date(2025, 3, 1))
    assert totals == {"PLN": -expected}
    assert sorted(ln.account.name for ln in lines) == ["Auto Test", "Hipoteka Test"]
    assert {str(ln.account.type) for ln in lines} == {"mortgage", "loan"}


def test_add_loan_twice_updates_it(session):
    add_loan(session, name="Auto Test", principal="60000", annual_rate="9.0", term_months=72,
             start_date=dt.date(2025, 3, 1))
    add_loan(session, name="Auto Test", principal="50000", annual_rate="8.0", term_months=60,
             start_date=dt.date(2025, 3, 1))
    ((loan, acc),) = list_loans(session)
    assert (loan.principal, loan.term_months, acc.name) == (Decimal(50000), 60, "Auto Test")
    with pytest.raises(ValueError, match="mortgage"):
        add_loan(session, name="X", principal="1", annual_rate="1", term_months=1,
                 start_date=dt.date(2025, 1, 1), type="checking")


def test_loans_endpoint_lists_every_loan_with_a_name(api):
    with get_session() as s:
        add_loan(s, name="Auto Test", principal="60000", annual_rate="9.0", term_months=72,
                 start_date=dt.date(2025, 3, 1), payment_text="RATA AUTO")
    loans = api.get("/api/p/default/loans").json()
    assert [(x["name"], x["type"]) for x in loans] == [
        ("Kredyt hipoteczny Test", "mortgage"), ("Auto Test", "loan")
    ]
    for x in loans:
        assert x["has_loan"] is True and x["id"] and x["account_id"]
        assert x["balance_source"] == "schedule"
        assert x["outstanding"] == x["schedule_outstanding"]
        assert len(x["schedule"]) == x["term_months"] or x["schedule"]
    assert loans[1]["payment_text"] == "RATA AUTO"
    # the legacy single-loan view is the first loan, same shape
    assert api.get("/api/loan").json() == loans[0]
    assert api.get("/api/p/default/loan").json() == loans[0]


def test_a_balance_recorded_after_the_terms_wins_over_the_schedule(session):
    acc = add_manual_position(session, name="Hipoteka Test", type="mortgage", value="390000",
                              on_date=dt.date(2026, 6, 1))
    loan = set_loan(session, acc.id, "400000", "6.0", 300, dt.date(2025, 1, 5))
    scheduled = _schedule_outstanding("400000", "6.0", 300, dt.date(2025, 1, 5))
    # the add-position placeholder was recorded before the terms: superseded
    assert net_worth(session)[0] == {"PLN": -scheduled}

    statement_day = dt.date(2026, 6, 1)
    set_balance(session, acc.id, "380000", on_date=statement_day)  # a bank statement
    rows = amortization.schedule(Decimal(400000), Decimal("6.0"), 300, dt.date(2025, 1, 5))
    repaid = amortization.outstanding(rows, statement_day) - amortization.outstanding(rows, TODAY)
    assert net_worth(session)[0] == {"PLN": -(Decimal(380000) - repaid)}
    # history: before the statement the schedule, from it on the recorded figure
    series = dict(net_worth_series(session))
    assert series[statement_day] == -Decimal(380000)

    # setting the terms again makes the schedule authoritative again
    set_loan(session, acc.id, loan.principal, loan.annual_rate, 300, dt.date(2025, 1, 5))
    assert net_worth(session)[0] == {"PLN": -scheduled}


def test_installments_are_loans_not_subscriptions(session):
    _home, car = _two_loans(session)
    bank = get_or_create_account(session, bank="mbank", iban="99114000000000000000000001")
    raws = []
    for m in (6, 7, 8, 9):
        raws.append(RawTransaction(  # car loan: matched by the lender account only
            booking_date=dt.date(2026, m, 10), amount=Decimal("-1081.94"),
            reference=f"PRZELEW {m:02d}/2026", counterparty_name="FINANSE TEST SA",
            counterparty_iban=LENDER, source=Source.CSV,
        ))
        raws.append(RawTransaction(  # a real subscription
            booking_date=dt.date(2026, m, 7), amount=Decimal("-43.00"), reference="NETFLIX.COM",
            source=Source.CSV,
        ))
    ingest_transactions(session, bank, raws, source=Source.CSV)
    session.flush()
    categorize_all(session)
    cats = {t.reference: t.category for t in session.exec(select(Transaction)).all()}
    assert cats["PRZELEW 06/2026"] == "loans"
    assert cats["NETFLIX.COM"] == "subscriptions"
    assert [c.counterparty for c in detect_recurring(session)] == ["NETFLIX.COM"]
    # without the lender account the installment would look like a subscription
    set_payment_matching(session, car.id, iban="")
    categorize_all(session)
    cats = {t.reference: t.category for t in session.exec(select(Transaction)).all()}
    assert cats["PRZELEW 06/2026"] == "subscriptions"


def test_loans_are_per_profile(session):
    jan = profiles.create_profile(session, name="Jan", modules_=["loans"])
    ola = profiles.create_profile(session, name="Ola", modules_=["loans"])
    _two_loans(session, profile_id=jan.id)
    assert len(list_loans(session, jan.id)) == 2
    assert list_loans(session, ola.id) == []
    assert net_worth(session, profile_id=ola.id)[0] == {}
    (loan, _acc) = list_loans(session, jan.id)[0]
    with pytest.raises(ValueError):
        set_payment_matching(session, loan.id, text="X", profile_id=ola.id)
    with pytest.raises(ValueError):
        set_loan(session, loan.account_id, "1", "1", 12, dt.date(2025, 1, 1), profile_id=ola.id)


def test_loans_setup_steps(api):
    body = api.get("/api/p/default/modules/loans/setup").json()
    assert [s["id"] for s in body["steps"]] == ["loan", "payments"]
    # the seed's installment is recognised by the built-in phrase -> payments done
    assert [s["status"] for s in body["steps"]] == ["done", "done"]


# --- R-01: loan terms attach only to an explicitly identified mortgage/loan account ---------


def test_a_loan_named_like_a_property_does_not_take_over_the_property(session):
    house = add_manual_position(session, name="Dom Test", type="property", value="800000")
    with pytest.raises(ValueError, match=rf"id {house.id}, property"):
        add_loan(session, name="Dom Test", type="mortgage", principal="300000",
                 annual_rate="6.0", term_months=300, start_date=dt.date(2025, 1, 5))
    assert list_loans(session) == []
    assert net_worth(session)[0] == {"PLN": Decimal(800000)}


def test_add_loan_attaches_to_an_account_given_by_id_or_exact_name(session):
    mortgage = add_manual_position(session, name="Kredyt Test", type="mortgage", value="1")
    add_manual_position(session, name="Dom Test", type="property", value="800000")
    loan = add_loan(session, account=mortgage.id, principal="300000", annual_rate="6.0",
                    term_months=300, start_date=dt.date(2025, 1, 5))
    assert loan.account_id == mortgage.id
    again = add_loan(session, account="Kredyt Test", principal="250000", annual_rate="6.0",
                     term_months=300, start_date=dt.date(2025, 1, 5))
    assert again.id == loan.id and again.principal == Decimal(250000)
    # an existing loan-type account of the same name is the one re-running updates
    by_name = add_loan(session, name="Kredyt Test", principal="200000", annual_rate="6.0",
                       term_months=300, start_date=dt.date(2025, 1, 5))
    assert by_name.id == loan.id
    assert len(list_loans(session)) == 1


@pytest.mark.parametrize("ref", ["Dom Test", "house-id"])
def test_add_loan_refuses_a_non_loan_account(session, ref):
    house = add_manual_position(session, name="Dom Test", type="property", value="800000")
    account = house.id if ref == "house-id" else ref
    with pytest.raises(ValueError, match="mortgage/loan"):
        add_loan(session, account=account, principal="1", annual_rate="1", term_months=12,
                 start_date=dt.date(2025, 1, 1))


def test_add_loan_with_an_ambiguous_name_lists_the_candidates(session):
    manual = add_manual_position(session, name="Kredyt Test", type="loan", value="1")
    bank = get_or_create_account(session, bank="mbank", name="Kredyt Test",
                                 external_id="eb:kredyt-test", type="loan")
    for kwargs in ({"name": "Kredyt Test"}, {"account": "Kredyt Test"}):
        with pytest.raises(ValueError, match="ambiguous") as err:
            add_loan(session, principal="1", annual_rate="1", term_months=12,
                     start_date=dt.date(2025, 1, 1), **kwargs)
        assert f"id {manual.id}" in str(err.value) and f"id {bank.id}" in str(err.value)
    loan = add_loan(session, account=bank.id, principal="1", annual_rate="1", term_months=12,
                    start_date=dt.date(2025, 1, 1))
    assert loan.account_id == bank.id


def test_add_loan_needs_exactly_one_of_name_and_account(session):
    with pytest.raises(ValueError, match="NAME"):
        add_loan(session, principal="1", annual_rate="1", term_months=12,
                 start_date=dt.date(2025, 1, 1))
    with pytest.raises(ValueError, match="not both"):
        add_loan(session, name="A", account="B", principal="1", annual_rate="1",
                 term_months=12, start_date=dt.date(2025, 1, 1))
    with pytest.raises(ValueError, match="No account named"):
        add_loan(session, account="Nope Test", principal="1", annual_rate="1",
                 term_months=12, start_date=dt.date(2025, 1, 1))


def test_set_loan_refuses_a_property_account(session):
    house = add_manual_position(session, name="Dom Test", type="property", value="800000")
    with pytest.raises(ValueError, match="mortgage/loan"):
        set_loan(session, house.id, "300000", "6.0", 300, dt.date(2025, 1, 5))


def test_net_worth_ignores_loan_terms_left_on_a_non_loan_account(session):
    """Rows written before the fix (terms on a property) no longer replace its value."""
    from cashu.modules.loans.models import Loan

    house = add_manual_position(session, name="Dom Test", type="property", value="800000")
    session.add(Loan(account_id=house.id, principal=Decimal(300000), annual_rate=Decimal(6),
                     term_months=300, start_date=dt.date(2025, 1, 5)))
    session.flush()
    assert net_worth(session)[0] == {"PLN": Decimal(800000)}


# --- R-11: a loan's own payment matching beats a cached (LLM) merchant rule -----------------


def _lender_installment(session):
    from cashu.modules.budget.categorize.rules import upsert_rule
    from cashu.modules.budget.ingestion.normalize import merchant_key

    _home, car = _two_loans(session)
    bank = get_or_create_account(session, bank="mbank", iban="99114000000000000000000001")
    ingest_transactions(session, bank, [RawTransaction(
        booking_date=dt.date(2026, 6, 10), amount=Decimal("-1081.94"), reference="PRZELEW 06/2026",
        counterparty_name="BANK TEST SA", counterparty_iban=LENDER, source=Source.CSV,
    )], source=Source.CSV)
    session.flush()
    mk = merchant_key("BANK TEST SA", "PRZELEW 06/2026", None)
    return car, mk, upsert_rule


def test_a_cached_llm_rule_does_not_beat_the_loans_payment_account(session):
    car, mk, upsert_rule = _lender_installment(session)
    upsert_rule(session, mk, "subscriptions", source="llm", locked=False)  # learned upstream
    categorize_all(session)
    txn = session.exec(select(Transaction)).one()
    assert (txn.category, txn.category_source) == ("loans", "keyword")
    # the same for the loan's title phrase
    set_payment_matching(session, car.id, iban="", text="PRZELEW 06/2026")
    categorize_all(session)
    assert session.exec(select(Transaction)).one().category == "loans"


def test_a_manual_merchant_rule_still_wins_over_the_loans_payment_account(session):
    _car, mk, upsert_rule = _lender_installment(session)
    upsert_rule(session, mk, "housing", source="manual")  # the user's explicit choice
    categorize_all(session)
    txn = session.exec(select(Transaction)).one()
    assert (txn.category, txn.category_source) == ("housing", "manual")
