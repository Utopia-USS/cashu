from datetime import date, timedelta
from decimal import Decimal

from finanse.core.accounts import get_or_create_account, upsert_balance
from finanse.core.networth import net_worth, net_worth_breakdown, net_worth_series
from finanse.models import AccountType, Source
from finanse.modules.budget.analytics import detect_recurring, monthly_cashflow
from finanse.modules.budget.ingestion.dedup import prepare_new_transactions
from finanse.modules.budget.ingestion.normalize import RawTransaction
from finanse.modules.budget.ingestion.transfers import match_internal_transfers
from finanse.modules.budget.service import ingest_transactions


def _raw(amount, d=date(2024, 1, 5), cp="Sklep ABC", source=Source.CSV, btid=None, iban=None):
    return RawTransaction(
        booking_date=d,
        amount=Decimal(amount),
        counterparty_name=cp,
        counterparty_iban=iban,
        description="test",
        source=source,
        bank_transaction_id=btid,
    )


def _commit(session, account, raws, source):
    res = prepare_new_transactions(session, account.id, raws)
    for t in res.to_insert:
        t.source = source
        session.add(t)
    session.commit()
    return res


def test_cross_source_dedup(session):
    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000005")
    session.commit()

    # CSV import first
    res1 = _commit(session, acc, [_raw("-49.99", source=Source.CSV)], Source.CSV)
    assert res1.num_inserted == 1

    # Open Banking sees the same real transaction (different source, has btid)
    res2 = _commit(session, acc, [_raw("-49.99", source=Source.OPEN_BANKING, btid="X1")], Source.OPEN_BANKING)
    assert res2.num_inserted == 0
    assert res2.num_duplicates == 1


def test_btid_idempotency(session):
    acc = get_or_create_account(session, bank="erste", iban="PL10000000000000000000000006")
    session.commit()

    ob = _raw("-20.00", source=Source.OPEN_BANKING, btid="ABC123")
    res1 = _commit(session, acc, [ob], Source.OPEN_BANKING)
    assert res1.num_inserted == 1

    # Re-sync overlapping window: same btid -> duplicate
    res2 = _commit(session, acc, [_raw("-20.00", source=Source.OPEN_BANKING, btid="ABC123")], Source.OPEN_BANKING)
    assert res2.num_inserted == 0


def test_identical_same_day_preserved(session):
    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000005")
    session.commit()

    # Two genuinely identical coffees on the same day -> both kept.
    res = _commit(session, acc, [_raw("-12.50"), _raw("-12.50")], Source.CSV)
    assert res.num_inserted == 2


def test_internal_transfer_matching(session):
    mbank_iban = "PL10000000000000000000000005"
    erste_iban = "PL10000000000000000000000006"
    mbank = get_or_create_account(session, bank="mbank", iban=mbank_iban, name="mBank")
    erste = get_or_create_account(session, bank="erste", iban=erste_iban, name="Erste")
    session.commit()

    # Outflow from mBank to Erste, inflow on Erste from mBank.
    out = _raw("-1000.00", d=date(2024, 2, 1), cp="Erste", iban=erste_iban)
    inc = _raw("1000.00", d=date(2024, 2, 2), cp="mBank", iban=mbank_iban)
    ingest_transactions(session, mbank, [out], source=Source.CSV)
    ingest_transactions(session, erste, [inc], source=Source.CSV)
    session.commit()

    pairs = match_internal_transfers(session)
    session.commit()
    assert pairs == 1

    _totals, lines = net_worth(session)  # no balances yet -> all None
    cashflow = monthly_cashflow(session)  # internal transfer excluded
    # The transfer legs must not show up as income/expense.
    assert all(mc.income == Decimal("0.00") and mc.expense == Decimal("0.00") for mc in cashflow)


def test_account_merges_across_iban_formats(session):
    # CSV stores a bare NRB; Open Banking returns the full IBAN with 'PL'.
    a1 = get_or_create_account(
        session, bank="mbank", iban="10000000000000000000000001", name="mBank główne"
    )
    session.commit()
    a2 = get_or_create_account(
        session, bank="mbank", iban="PL10000000000000000000000001", external_id="eb-uid-1"
    )
    session.commit()
    assert a2.id == a1.id  # merged, not duplicated


def test_recurring_detects_monthly_subscription(session):
    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000005")
    session.commit()

    d0 = date(2026, 1, 5)
    raws = []
    # a real subscription: same merchant, same amount, ~monthly
    for i in range(4):
        raws.append(
            RawTransaction(
                booking_date=d0 + timedelta(days=30 * i),
                amount=Decimal("-19.99"),
                reference="SPOTIFY P/WARSZAWA      DATA TRANSAKCJI: 2026-01-05",
                description="ZAKUP PRZY UZYCIU KARTY",
                source=Source.CSV,
            )
        )
    # noise: same merchant but variable amounts -> must NOT be flagged
    for i, amt in enumerate(["-12.30", "-40.10", "-8.00"]):
        raws.append(
            RawTransaction(
                booking_date=d0 + timedelta(days=7 * i),
                amount=Decimal(amt),
                reference="BIEDRONKA/KRAKOW        DATA TRANSAKCJI: 2026-01-05",
                source=Source.CSV,
            )
        )
    ingest_transactions(session, acc, raws, source=Source.CSV)
    session.commit()

    rec = detect_recurring(session)
    assert any(
        c.counterparty.startswith("SPOTIFY") and c.typical_amount == Decimal("19.99") for c in rec
    )
    assert all("BIEDRONKA" not in c.counterparty for c in rec)


def test_credit_card_limit_not_counted_debt_is(session):
    checking = get_or_create_account(
        session, bank="erste", iban="PL10000000000000000000000006",
        type=AccountType.CHECKING,
    )
    limit_card = get_or_create_account(
        session, bank="erste", iban="PL10000000000000000000000007",
        external_id="card-1", type=AccountType.CREDIT,
    )
    drawn_card = get_or_create_account(
        session, bank="mbank", iban="PL10000000000000000000000008",
        external_id="card-2", type=AccountType.CREDIT,
    )
    session.commit()
    upsert_balance(session, checking, date(2026, 7, 1), Decimal("5000.00"), source=Source.OPEN_BANKING)
    # positive = available credit / limit -> not an asset, contributes 0
    upsert_balance(session, limit_card, date(2026, 7, 1), Decimal("1000.00"), source=Source.OPEN_BANKING)
    # negative = money owed -> subtracts
    upsert_balance(session, drawn_card, date(2026, 7, 1), Decimal("-300.00"), source=Source.OPEN_BANKING)
    session.commit()

    totals, lines = net_worth(session)
    assert totals["PLN"] == Decimal("4700.00")  # 5000 − 300 debt; limit ignored
    by_id = {ln.account.id: ln for ln in lines}
    assert by_id[limit_card.id].contribution == Decimal("0")
    assert by_id[drawn_card.id].contribution == Decimal("-300.00")


def test_cashflow_excludes_own_account_transfer(session):
    a = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    get_or_create_account(session, bank="erste", iban="PL10000000000000000000000004")
    session.commit()
    # transfer to our OWN Erste account (unmatched as a pair, but counterparty is own)
    ingest_transactions(session, a, [
        RawTransaction(booking_date=date(2026, 3, 5), amount=Decimal("-1000.00"),
                       counterparty_iban="10000000000000000000000004", source=Source.CSV),
        RawTransaction(booking_date=date(2026, 3, 6), amount=Decimal("-200.00"),
                       counterparty_iban="PL88888888888888888888888888", source=Source.CSV),
    ], source=Source.CSV)
    session.commit()

    mar = next(m for m in monthly_cashflow(session) if m.label == "2026-03")
    assert mar.expense == Decimal("200.00")  # own-account transfer excluded, external kept


def test_net_worth_breakdown_with_property_and_mortgage(session):
    chk = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    prop = get_or_create_account(session, bank="manual", external_id="manual:flat",
                                 name="Mieszkanie", type=AccountType.PROPERTY)
    mort = get_or_create_account(session, bank="manual", external_id="manual:mort",
                                 name="Hipoteka", type=AccountType.MORTGAGE)
    session.commit()
    upsert_balance(session, chk, date(2026, 7, 1), Decimal("5000.00"), source=Source.OPEN_BANKING)
    upsert_balance(session, prop, date(2026, 7, 1), Decimal("850000.00"), source=Source.MANUAL)
    upsert_balance(session, mort, date(2026, 7, 1), Decimal("420000.00"), source=Source.MANUAL)
    session.commit()

    bd = net_worth_breakdown(session)
    assert bd.assets == Decimal("855000.00")
    assert bd.liabilities == Decimal("420000.00")
    assert bd.net == Decimal("435000.00")
    assert bd.home_equity == Decimal("430000.00")


def test_net_worth_series_monthly_smoothing(session):
    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    session.commit()
    for d, v in [(date(2026, 1, 10), "100"), (date(2026, 1, 20), "150"), (date(2026, 2, 5), "200")]:
        upsert_balance(session, acc, d, Decimal(v), source=Source.OPEN_BANKING)
    session.commit()

    monthly = net_worth_series(session, granularity="monthly")
    assert [v for _d, v in monthly] == [Decimal("150"), Decimal("200")]  # period-end per month
    assert len(net_worth_series(session, granularity="daily")) == 3


def test_categorization_and_spending(session):
    from finanse.modules.budget.analytics import spending_by_category
    from finanse.modules.budget.ingestion.normalize import merchant_key
    from finanse.modules.budget.service import categorize_all, recategorize_merchant

    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    session.commit()
    ingest_transactions(session, acc, [
        RawTransaction(booking_date=date(2026, 5, 2), amount=Decimal("-24.47"),
                       reference="CARREFOUR EXPRESS K/KRAKOW  DATA TRANSAKCJI: 2026-05-02", source=Source.CSV),
        RawTransaction(booking_date=date(2026, 5, 3), amount=Decimal("-19.99"),
                       reference="NETFLIX.COM", source=Source.CSV),
        RawTransaction(booking_date=date(2026, 5, 4), amount=Decimal("-50.00"),
                       reference="JAKISTAM SKLEP XYZ", source=Source.CSV),  # unknown -> other
    ], source=Source.CSV)
    session.commit()

    categorize_all(session, use_llm=False)  # deterministic only (no API needed)
    session.commit()
    cats = {c.category: c.amount for c in spending_by_category(session, year=2026, month=5)}
    assert cats.get("groceries") == Decimal("24.47")
    assert cats.get("subscriptions") == Decimal("19.99")
    assert cats.get("other") == Decimal("50.00")

    # manual correction becomes a durable rule and re-applies
    mk = merchant_key(None, "JAKISTAM SKLEP XYZ", None)
    assert recategorize_merchant(session, mk, "shopping") == 1
    session.commit()
    cats2 = {c.category: c.amount for c in spending_by_category(session, year=2026, month=5)}
    assert cats2.get("shopping") == Decimal("50.00")
    assert "other" not in cats2


def test_loan_amortization():
    from finanse.modules.loans import amortization as loan

    P, r, n = 680000, 6.27, 360
    m = loan.monthly_payment(P, r, n)
    assert Decimal("4150") < m < Decimal("4250")  # ~4196 zł
    summ = loan.summarize(P, r, n, date(2026, 7, 1), date(2026, 7, 1))
    assert summ.months_elapsed == 1
    assert summ.outstanding < Decimal("680000")  # first payment reduced principal
    assert len(summ.schedule) == 360
    assert summ.schedule[-1].balance == Decimal("0.00")
    assert summ.total_interest > Decimal("700000")  # 30y interest is huge

    # disbursed 2026-07-20, first installment 2026-08-17: on 07-21 nothing paid,
    # full principal owed (not 0, not "one payment made").
    su = loan.summarize(P, r, n, date(2026, 8, 17), date(2026, 7, 21),
                        origination_date=date(2026, 7, 20))
    assert su.months_elapsed == 0
    assert su.outstanding == Decimal("680000.00")
    assert su.paid_interest == Decimal("0.00")
    # before disbursement the loan doesn't exist yet
    assert loan.outstanding(su.schedule, date(2026, 7, 10), date(2026, 7, 20)) == Decimal("0")


def test_transaction_category_override_survives_recategorize(session):
    from sqlmodel import select

    from finanse.models import Transaction
    from finanse.modules.budget.service import categorize_all, set_transaction_category

    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    session.commit()
    ingest_transactions(session, acc, [
        RawTransaction(booking_date=date(2026, 5, 2), amount=Decimal("-24.47"),
                       reference="CARREFOUR EXPRESS", source=Source.CSV),
    ], source=Source.CSV)
    session.commit()

    categorize_all(session, use_llm=False)
    session.commit()
    t = session.exec(select(Transaction)).first()
    assert t.category == "groceries"

    set_transaction_category(session, t.id, "dining")
    session.commit()
    categorize_all(session, use_llm=False)  # must NOT overwrite the manual per-txn override
    session.commit()
    t2 = session.get(Transaction, t.id)
    assert t2.category == "dining" and t2.category_source == "manual_txn"


def test_spending_by_quarter_and_year(session):
    from finanse.modules.budget.analytics import spending_by_category
    from finanse.modules.budget.service import categorize_all

    acc = get_or_create_account(session, bank="mbank", iban="PL10000000000000000000000001")
    session.commit()
    ingest_transactions(session, acc, [
        RawTransaction(booking_date=date(2026, 5, 2), amount=Decimal("-100"), reference="NETFLIX.COM", source=Source.CSV),  # Q2
        RawTransaction(booking_date=date(2026, 8, 2), amount=Decimal("-50"), reference="NETFLIX.COM", source=Source.CSV),   # Q3
    ], source=Source.CSV)
    session.commit()
    categorize_all(session, use_llm=False)
    session.commit()

    q2 = {c.category: c.amount for c in spending_by_category(session, year=2026, quarter=2)}
    q3 = {c.category: c.amount for c in spending_by_category(session, year=2026, quarter=3)}
    yr = {c.category: c.amount for c in spending_by_category(session, year=2026)}
    assert q2.get("subscriptions") == Decimal("100")
    assert q3.get("subscriptions") == Decimal("50")
    assert yr.get("subscriptions") == Decimal("150")


def test_fx_conversion_is_transfer(session):
    from finanse.models import Transaction
    from finanse.modules.budget.categorize import engine

    t = Transaction(account_id=1, booking_date=date(2026, 1, 1), amount=Decimal("-500"),
                    description="OBCIĄŻ. NATYCH. TRANSAKCJA WALUT.", dedup_hash="x", source=Source.CSV)
    cat, src = engine.categorize(t, own_ibans=set(), rules={}, subscription_keys=set())
    assert cat == "transfer" and src == "transfer"


def test_net_worth_uses_balances(session):
    acc = get_or_create_account(session, bank="erste", iban="PL10000000000000000000000006")
    session.commit()
    upsert_balance(session, acc, date(2024, 3, 1), Decimal("1234.56"), source=Source.OPEN_BANKING)
    session.commit()

    totals, lines = net_worth(session)
    assert totals["PLN"] == Decimal("1234.56")
    assert lines[0].amount == Decimal("1234.56")
