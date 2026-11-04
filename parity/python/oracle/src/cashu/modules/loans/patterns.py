"""How the budget recognises loan installments (``ModuleSpec`` categorization hooks).

Installments are plain bank transfers, usually to a bank whose name says nothing
about them; without these hooks a monthly same-amount installment looks like a
subscription. The phrases apply to every profile; each loan can also name its
lender account (``payment_iban``) or a title phrase (``payment_text``).
"""

from __future__ import annotations

from sqlmodel import Session, select

from cashu.core.modules import PaymentPattern
from cashu.core.profiles import account_ids_query
from cashu.core.text import normalize_text

from .models import Loan

LOANS_CATEGORY = "loans"

# Matched against the whole normalized transaction text of outflows (Polish bank
# data, keep verbatim): "RATA KREDYTU HIPOTECZNEGO", "SPLATA RATY", ...
INSTALLMENT_PHRASES: tuple[tuple[str, str], ...] = (
    ("RATA KREDYTU", LOANS_CATEGORY),
    ("RATY KREDYTU", LOANS_CATEGORY),
    ("SPLATA KREDYTU", LOANS_CATEGORY),
    ("SPLATA RATY", LOANS_CATEGORY),
    ("RATA POZYCZKI", LOANS_CATEGORY),
    ("SPLATA POZYCZKI", LOANS_CATEGORY),
    ("RATA LEASING", LOANS_CATEGORY),
    ("KREDYT HIPOTECZNY", LOANS_CATEGORY),
)


def payment_patterns(session: Session, profile_id: int) -> list[PaymentPattern]:
    loans = session.exec(
        select(Loan).where(Loan.account_id.in_(account_ids_query(profile_id)))
    ).all()
    out: list[PaymentPattern] = []
    for loan in loans:
        if loan.payment_iban or loan.payment_text:
            out.append(
                PaymentPattern(
                    LOANS_CATEGORY,
                    counterparty_iban=loan.payment_iban or None,
                    text=normalize_text(loan.payment_text) or None,
                )
            )
    return out
