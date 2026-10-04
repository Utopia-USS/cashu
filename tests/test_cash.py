"""Cash-pool tracking: withdrawals feed the pool (net-worth-neutral), manual
expenses draw it down (real spend)."""

from datetime import date
from decimal import Decimal

from sqlmodel import select

from finanse.core.accounts import get_or_create_account, upsert_balance
from finanse.core.networth import net_worth, net_worth_series
from finanse.models import AccountType, Source, Transaction
from finanse.modules.budget.analytics import monthly_cashflow, spending_by_category
from finanse.modules.budget.cash import add_cash_expense, delete_cash_transaction, get_cash_account
from finanse.modules.budget.service import set_transaction_category


def _bank_account(session, balance="1000.00", on=date(2024, 1, 10)):
    acc = get_or_create_account(
        session, bank="mbank", name="mBank", iban="PL10 1140 0000 0000 0000 1234"
    )
    session.flush()
    # A balance snapshot reflects the current bank balance (post-withdrawal).
    upsert_balance(session, acc, on, Decimal(balance), source=Source.CSV)
    return acc


def _withdrawal(session, acc, amount="-200.00", d=date(2024, 1, 5)):
    t = Transaction(
        account_id=acc.id,
        booking_date=d,
        amount=Decimal(amount),
        currency="PLN",
        description="WYPLATA W BANKOMACIE",
        reference="WYPLATA W BANKOMACIE",
        source=Source.CSV,
        dedup_hash=f"wd-{d}-{amount}",
        category="cash",
        category_source="keyword",
    )
    session.add(t)
    session.flush()
    return t


def test_marking_withdrawal_feeds_pool_and_is_networth_neutral(session):
    acc = get_or_create_account(
        session, bank="mbank", name="mBank", iban="PL10 1140 0000 0000 0000 1234"
    )
    session.flush()
    # Pre-withdrawal state: bank holds 1200, no cash yet.
    upsert_balance(session, acc, date(2024, 1, 4), Decimal("1200.00"), source=Source.CSV)
    before, _ = net_worth(session)

    # Jan 5: withdraw 200 -> bank balance drops to 1000, a withdrawal txn is recorded.
    upsert_balance(session, acc, date(2024, 1, 5), Decimal("1000.00"), source=Source.CSV)
    w = _withdrawal(session, acc, "-200.00", d=date(2024, 1, 5))
    set_transaction_category(session, w.id, "cash_withdrawal")
    session.flush()

    cash = get_cash_account(session, "PLN")
    assert cash is not None and cash.type == AccountType.CASH

    # A mirror credit exists on the cash account -> pool = +200, and the two legs
    # (bank -200, cash +200) cancel: a withdrawal is a transfer, not a spend.
    mirrors = session.exec(
        select(Transaction).where(Transaction.account_id == cash.id)
    ).all()
    assert [m.amount for m in mirrors] == [Decimal("200.00")]
    assert w.amount + mirrors[0].amount == Decimal("0.00")

    after, _ = net_worth(session)
    assert after["PLN"] == before["PLN"]  # 1200 bank -> 1000 bank + 200 cash


def test_withdrawal_excluded_from_spending_and_cashflow(session):
    acc = _bank_account(session)
    w = _withdrawal(session, acc, "-200.00")

    # Before marking, it counts as a "cash" expense.
    assert any(c.category == "cash" for c in spending_by_category(session))

    set_transaction_category(session, w.id, "cash_withdrawal")
    session.flush()

    cats = {c.category for c in spending_by_category(session)}
    assert "cash" not in cats and "cash_withdrawal" not in cats
    for mc in monthly_cashflow(session):
        assert mc.income == Decimal("0.00")  # the +200 cash leg is not income


def test_cash_expense_draws_pool_and_counts_as_spend(session):
    acc = _bank_account(session)
    w = _withdrawal(session, acc, "-200.00")
    set_transaction_category(session, w.id, "cash_withdrawal")
    session.flush()

    add_cash_expense(session, amount=50, title="Obiad", category="dining")
    session.flush()

    cash = get_cash_account(session, "PLN")
    balance = sum(
        (t.amount for t in session.exec(
            select(Transaction).where(Transaction.account_id == cash.id)).all()),
        Decimal(0),
    )
    assert balance == Decimal("150.00")  # 200 in - 50 out

    dining = [c for c in spending_by_category(session) if c.category == "dining"]
    assert dining and dining[0].amount == Decimal("50.00")


def test_unmark_removes_mirror_and_reverts_source(session):
    acc = _bank_account(session)
    w = _withdrawal(session, acc, "-200.00")
    set_transaction_category(session, w.id, "cash_withdrawal")
    session.flush()

    cash = get_cash_account(session, "PLN")
    mirror = session.exec(
        select(Transaction).where(Transaction.account_id == cash.id)
    ).first()

    assert delete_cash_transaction(session, mirror.id) is True
    session.flush()

    assert session.exec(
        select(Transaction).where(Transaction.account_id == cash.id)
    ).all() == []
    # Source bank txn is re-categorized back to a normal cash expense.
    assert session.get(Transaction, w.id).category == "cash"


def test_cash_account_appears_in_networth_series(session):
    acc = _bank_account(session)
    w = _withdrawal(session, acc, "-200.00")
    set_transaction_category(session, w.id, "cash_withdrawal")
    session.flush()
    add_cash_expense(session, amount=50, title="Obiad", category="dining", on_date=date(2024, 1, 8))
    session.flush()

    series = net_worth_series(session, granularity="daily")
    assert series, "series should not be empty with cash + bank balances"
    # Last point includes the cash pool (150) on top of the bank balance (1000).
    assert series[-1][1] == Decimal("1150.00")
