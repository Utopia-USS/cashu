"""Full-context LLM reclassification: signature grouping, structural exclusion,
and the direction (sign) guardrail. The LLM transport is stubbed so these run
offline."""

from datetime import date
from decimal import Decimal

from cashu.core.accounts import get_or_create_account
from cashu.models import AccountType, Source, Transaction
from cashu.modules.budget.categorize import local_llm
from cashu.modules.budget.categorize.reclassify import (
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
    from cashu.modules.budget.ingestion.normalize import iban_key

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


def test_manual_only_categories_are_never_offered_to_the_llm(session, monkeypatch):
    """`private` (transfers to and from other people) is the owner's call: the LLM never sees it."""
    from cashu.modules.budget.categorize import taxonomy

    assert "private" in taxonomy.CATEGORY_KEYS
    assert "private" not in taxonomy.AUTO_CATEGORY_KEYS

    acc = get_or_create_account(session, bank="mbank", name="mBank", iban="PL99 1140 0000 0000 0000 8888")
    session.flush()
    _txn(session, acc.id, "-40", ref="PRZELEW NA TELEFON ASIA", cat="other", dh="p2p")
    seen: dict = {}

    def fake(items, keys, labels, **kw):
        seen["keys"], seen["labels"] = list(keys), dict(labels)
        return {tid: {"category": "other", "confidence": 0.5} for tid, _ in items}

    monkeypatch.setattr(local_llm, "classify_transactions", fake)
    reclassify_all(session, model="stub", batch_size=10)
    assert "private" not in seen["keys"] and "private" not in seen["labels"]
    assert "transfer" not in seen["keys"]


def _always(category: str):
    def fake(items, keys, labels, **kw):
        return {tid: {"category": category, "confidence": 0.9} for tid, _ in items}
    return fake


def test_reclassify_never_overwrites_owner_decisions(session, monkeypatch):
    """Manual rows, the owner's merchant rules, owner-only categories and loan
    pattern matches survive a full LLM reclassification."""
    from cashu.modules.budget.service import recategorize_merchant, set_transaction_category
    from cashu.modules.loans.service import add_loan

    acc = get_or_create_account(session, bank="mbank", name="mBank", iban="PL99 1140 0000 0000 0000 7777")
    session.flush()
    manual = _txn(session, acc.id, "-25", ref="KWIACIARNIA ROZA", cat="other", dh="m1")
    set_transaction_category(session, manual.id, "gifts")
    ruled = _txn(session, acc.id, "-60", cp="SKLEP ZOOLOGICZNY BUREK", cat="other", dh="r1")
    session.flush()
    recategorize_merchant(session, "SKLEP ZOOLOGICZNY BUREK", "shopping")
    private = _txn(session, acc.id, "-200", ref="ZA BILETY", cat="private", dh="pv")
    add_loan(session, name="Auto", principal="30000", annual_rate="8", term_months=48,
             start_date=date(2025, 1, 1), payment_text="UMOWA 123 AUTO")
    loan_row = _txn(session, acc.id, "-700", ref="UMOWA 123 AUTO", cat="loans", dh="ln")
    # A row an earlier LLM pass put elsewhere: the loan pattern now decides it.
    loan_llm = _txn(session, acc.id, "-700", ref="UMOWA 123 AUTO LUTY", cat="subscriptions", dh="ln2")
    loan_llm.category_source = "llm_full"
    phrase_row = _txn(session, acc.id, "-1500", ref="SPLATA RATY 05/2026", cat="loans", dh="ph")
    free = _txn(session, acc.id, "-30", ref="LIDL", cat="other", dh="free")
    session.flush()

    monkeypatch.setattr(local_llm, "classify_transactions", _always("entertainment"))
    res = reclassify_all(session, model="stub", batch_size=10)
    session.flush()

    def get(t):
        return session.get(Transaction, t.id)

    assert (get(manual).category, get(manual).category_source) == ("gifts", "manual_txn")
    assert (get(ruled).category, get(ruled).category_source) == ("shopping", "manual")
    assert get(private).category == "private"
    assert get(loan_row).category == "loans"
    assert get(loan_llm).category == "loans"
    assert get(phrase_row).category == "loans"
    assert get(free).category == "entertainment"
    assert res["targets"] == 1 and res["configured_txns"] == 3


def test_fallback_rows_stay_open_to_a_later_loan_pattern(session, monkeypatch):
    """A group the model did not answer is not frozen: a loan pattern set later applies."""
    from cashu.modules.budget.service import categorize_all
    from cashu.modules.loans.service import add_loan

    acc = get_or_create_account(session, bank="mbank", name="mBank", iban="PL99 1140 0000 0000 0000 6666")
    session.flush()
    row = _txn(session, acc.id, "-900", ref="PRZELEW BANK XYZ 4711", cat="other", dh="fb")
    monkeypatch.setattr(local_llm, "classify_transactions", lambda items, *a, **kw: {})
    res = reclassify_all(session, model="stub", batch_size=10)
    session.flush()
    assert res["fallback_txns"] == 1
    assert session.get(Transaction, row.id).category_source != "llm_fallback"

    add_loan(session, name="Hipo", principal="300000", annual_rate="7", term_months=300,
             start_date=date(2025, 1, 1), payment_text="BANK XYZ 4711")
    categorize_all(session)
    assert session.get(Transaction, row.id).category == "loans"


def test_categorize_all_applies_a_loan_pattern_to_llm_rows(session):
    from cashu.modules.budget.service import categorize_all
    from cashu.modules.loans.service import add_loan

    acc = get_or_create_account(session, bank="mbank", name="mBank", iban="PL99 1140 0000 0000 0000 5555")
    session.flush()
    row = _txn(session, acc.id, "-900", ref="UMOWA 9 LEASING AUTA", cat="subscriptions", dh="lf")
    row.category_source = "llm_full"
    keep = _txn(session, acc.id, "-40", ref="NETFLIX", cat="entertainment", dh="nf")
    keep.category_source = "llm_full"
    session.flush()
    add_loan(session, name="Leasing", principal="50000", annual_rate="9", term_months=36,
             start_date=date(2025, 1, 1), payment_text="UMOWA 9 LEASING")
    categorize_all(session)
    assert session.get(Transaction, row.id).category == "loans"
    assert session.get(Transaction, keep.id).category == "entertainment"
