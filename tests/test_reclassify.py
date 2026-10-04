"""Full-context LLM reclassification: signature grouping, structural exclusion,
and the direction (sign) guardrail. The LLM transport is stubbed so these run
offline."""

from datetime import date
from decimal import Decimal

from finanse.core.accounts import get_or_create_account
from finanse.models import AccountType, Source, Transaction
from finanse.modules.budget.categorize import local_llm
from finanse.modules.budget.categorize.reclassify import (
    _is_structural,
    reclassify_all,
    txn_signature,
)


def _txn(session, account_id, amount, *, cp=None, ref=None, desc=None, cat=None, internal=False,
         cp_iban=None, src=Source.OPEN_BANKING, dh=None):
    t = Transaction(
        account_id=account_id, booking_date=date(2026, 1, 1), amount=Decimal(amount),
        currency="PLN", counterparty_name=cp, counterparty_iban=cp_iban, reference=ref,
        description=desc, category=cat, is_internal_transfer=internal, source=src,
        dedup_hash=dh or f"h{amount}{ref}{desc}",
    )
    session.add(t)
    session.flush()
    return t


def test_signature_groups_by_full_detail_not_merchant():
    # Same gateway, different embedded merchant -> DIFFERENT signatures.
    a = Transaction(account_id=1, booking_date=date(2026, 1, 1), amount=Decimal(-10),
                    reference="PayU*Allegro /Poznan", source=Source.OPEN_BANKING, dedup_hash="a")
    b = Transaction(account_id=1, booking_date=date(2026, 1, 1), amount=Decimal(-10),
                    reference="PayU*Steam /Lux", source=Source.OPEN_BANKING, dedup_hash="b")
    assert txn_signature(a) != txn_signature(b)

    # Same merchant, different amount/date -> SAME signature (collapsed).
    c = Transaction(account_id=1, booking_date=date(2026, 1, 1), amount=Decimal("-82.54"),
                    reference="PŁATNOŚĆ KARTĄ 82.54 PLN LIDL KOBIERZYNSKA", source=Source.CSV, dedup_hash="c")
    d = Transaction(account_id=1, booking_date=date(2026, 1, 2), amount=Decimal("-19.99"),
                    reference="PŁATNOŚĆ KARTĄ 19.99 PLN LIDL KOBIERZYNSKA", source=Source.CSV, dedup_hash="d")
    assert txn_signature(c) == txn_signature(d)


def test_structural_transactions_excluded(session):
    from finanse.modules.budget.ingestion.normalize import iban_key

    acc = get_or_create_account(session, bank="mbank", name="mBank",
                                iban="PL10 1140 0000 0000 0000 1234")
    session.flush()
    own_iban = "PL11 1400 0000 0000 0000 1234"
    own = {iban_key(own_iban)}
    cash = get_or_create_account(session, bank="manual", name="Gotówka",
                                 external_id="cash:PLN", type=AccountType.CASH)
    session.flush()

    internal = _txn(session, acc.id, "-100", internal=True, dh="s1")
    to_own = _txn(session, acc.id, "-100", cp_iban=own_iban, dh="s2")
    transfer_cat = _txn(session, acc.id, "-100", cat="transfer", dh="s3")
    cash_wd = _txn(session, acc.id, "-100", cat="cash_withdrawal", dh="s4")
    cash_exp = _txn(session, cash.id, "-50", cat="dining", dh="s5")
    real = _txn(session, acc.id, "-30", ref="LIDL", dh="s6")

    cash_ids = {cash.id}
    assert _is_structural(internal, own, cash_ids)
    assert _is_structural(to_own, own, cash_ids)
    assert _is_structural(transfer_cat, own, cash_ids)
    assert _is_structural(cash_wd, own, cash_ids)
    assert _is_structural(cash_exp, own, cash_ids)
    assert not _is_structural(real, own, cash_ids)


def test_reclassify_applies_and_sign_guardrail(session, monkeypatch):
    acc = get_or_create_account(session, bank="mbank", name="mBank", iban="PL99 1140 0000 0000 0000 9999")
    session.flush()
    spend = _txn(session, acc.id, "-30", ref="LIDL", cat="other", dh="spend")
    inflow = _txn(session, acc.id, "1500", ref="Jan Kowalski przelew", cat="other", dh="in")
    # Internal transfer must be left untouched.
    internal = _txn(session, acc.id, "-500", ref="own move", cat="transfer", internal=True, dh="int")

    # Stub the LLM: deliberately return the WRONG direction for both to exercise
    # the guardrail — income for the outflow, groceries for the inflow.
    def fake(items, keys, labels, **kw):
        out = {}
        for tid, ctx in items:
            out[tid] = {"category": "income_salary" if "LIDL" in ctx else "groceries", "confidence": 0.9}
        return out

    monkeypatch.setattr(local_llm, "classify_transactions", fake)

    res = reclassify_all(session, model="stub", batch_size=10)
    session.flush()

    assert session.get(Transaction, spend.id).category == "other"        # income->other (outflow)
    assert session.get(Transaction, spend.id).category_source == "llm_full"
    assert session.get(Transaction, inflow.id).category == "income_other"  # groceries->income (inflow)
    assert session.get(Transaction, internal.id).category == "transfer"    # untouched
    assert res["targets"] == 2 and res["classified_txns"] == 2
