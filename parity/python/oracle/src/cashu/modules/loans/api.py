"""Loans API routes (profile-scoped): every loan of the profile, the legacy single-loan view, and the
first-steps writes (F10).

- ``GET   /loans``                 every loan (``loan_summary`` shape), oldest first.
- ``POST  /loans``                 ``{name, type: mortgage|loan, principal, annual_rate (percent),
  term_months, start_date, origination_date?, currency?}`` -> 201 one ``GET /loans`` item; 409
  ``loan_name_taken`` when a mortgage / loan of that name exists (the CLI updates it; the app does
  not edit terms yet); 422 for invalid terms (``loan_invalid``).
- ``PATCH /loans/{id}/payment``    ``{text?, iban?}`` (at least one; ``""`` or null clears it) ->
  ``{loan, matched}``: how the budget recognises the installments; re-categorizes the profile when the
  budget module is on, ``matched`` = the profile's outflows now in category ``loans`` that this loan's
  IBAN or phrase matches (0 without budget). The full IBAN never leaves the server
  (``payment_iban_tail``).
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from cashu.core import modules, profiles
from cashu.core.api import CurrentProfile
from cashu.core.db import get_session
from cashu.core.models import Account, AccountType
from cashu.core.text import iban_key, normalize_iban, normalize_text

from .models import Loan
from .patterns import LOANS_CATEGORY
from .service import (
    LOAN_TYPES,
    add_loan,
    get_loan,
    list_loans,
    loan_summary,
    set_payment_matching,
)

router = APIRouter()

MAX_NAME = 120
MAX_PHRASE = 200


@router.get("/loans")
def loans(profile: CurrentProfile) -> list[dict]:
    """Every loan of the profile (oldest first), each in the ``/loan`` shape plus
    ``id``, ``account_id``, ``name`` (the account name) and ``type``."""
    today = date.today()  # noqa: DTZ011 - naive local date, like the booking dates
    with get_session() as s:
        return [loan_summary(s, loan, acc, today) for loan, acc in list_loans(s, profile.id)]


@router.get("/loan")
def loan_info(profile: CurrentProfile) -> dict:
    """The profile's first loan (upstream shape, kept for the legacy dashboard)."""
    today = date.today()  # noqa: DTZ011 - naive local date, like the booking dates
    with get_session() as s:
        rows = list_loans(s, profile.id)
        if not rows:
            return {"has_loan": False}
        loan, acc = rows[0]
        return loan_summary(s, loan, acc, today)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message, headers={"X-Cashu-Error-Code": code})


def _invalid(message: str) -> HTTPException:
    return _error(422, "loan_invalid", message)


class LoanCreate(BaseModel):
    name: str
    type: str = AccountType.MORTGAGE
    principal: float
    annual_rate: float
    term_months: int
    start_date: date
    origination_date: date | None = None
    currency: str | None = None


def _check(body: LoanCreate, base_currency: str | None) -> tuple[str, str]:
    name = " ".join((body.name or "").split())
    if not name or len(name) > MAX_NAME:
        raise _invalid(f"name is required (max {MAX_NAME} characters)")
    if str(body.type) not in LOAN_TYPES:
        raise _invalid("type must be mortgage or loan")
    if not body.principal > 0:
        raise _invalid("principal must be greater than 0")
    if not 0 <= body.annual_rate <= 100:
        raise _invalid("annual_rate must be a percentage from 0 to 100")
    if not 1 <= body.term_months <= 600:
        raise _invalid("term_months must be from 1 to 600")
    if body.origination_date is not None and body.origination_date > body.start_date:
        raise _invalid("origination_date must not be after start_date")
    currency = (body.currency or base_currency or "PLN").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise _invalid("currency must be a 3-letter code")
    return name, currency


def _name_taken(session: Session, profile_id: int, name: str) -> bool:
    rows = session.exec(
        select(Account).where(
            Account.profile_id == profile_id,
            Account.name == name,
            Account.removed_at.is_(None),
        )
    ).all()
    return any(str(a.type) in LOAN_TYPES for a in rows)


@router.post("/loans", status_code=201)
def create_loan(profile: CurrentProfile, body: LoanCreate) -> dict:
    """A new loan: its liability account plus the amortization terms (``loans add``)."""
    name, currency = _check(body, profile.base_currency)
    with get_session() as s:
        if _name_taken(s, profile.id, name):
            raise _error(409, "loan_name_taken", "A loan with this name already exists")
        try:
            loan = add_loan(
                s,
                name=name,
                principal=str(body.principal),
                annual_rate=str(body.annual_rate),
                term_months=body.term_months,
                start_date=body.start_date,
                origination_date=body.origination_date,
                type=body.type,
                currency=currency,
                profile_id=profile.id,
            )
        except ValueError as e:
            raise _invalid(str(e)) from None
        s.flush()
        account = s.get(Account, loan.account_id)
        out = loan_summary(s, loan, account, date.today())  # noqa: DTZ011 - local dates
    return out


class PaymentPatch(BaseModel):
    text: str | None = None
    iban: str | None = None


def _matched(session: Session, profile_id: int, loan: Loan) -> int:
    """The profile's outflows in category ``loans`` that this loan's IBAN or phrase matches (the
    budget's categorization rule, ``categorize.engine``: the phrase against the normalized title,
    description and counterparty name). Reads the budget's table by name (loans never imports budget
    code; every module's tables always exist)."""
    from sqlalchemy import text

    phrase = normalize_text(loan.payment_text)
    iban = iban_key(loan.payment_iban) if loan.payment_iban else ""
    if not phrase and not iban:
        return 0
    rows = session.exec(
        text(
            "SELECT t.amount, t.counterparty_iban, t.reference, t.description, t.counterparty_name "
            "FROM transactions t JOIN accounts a ON a.id = t.account_id "
            "WHERE a.profile_id = :pid AND t.category = :cat"
        ).bindparams(pid=profile_id, cat=LOANS_CATEGORY)
    ).all()
    n = 0
    for amount, cp_iban, reference, description, counterparty in rows:
        try:
            if float(amount) > 0:
                continue
        except (TypeError, ValueError):
            continue
        joined = normalize_text(" ".join(x for x in (reference, description, counterparty) if x))
        if (iban and cp_iban and iban_key(cp_iban) == iban) or (phrase and phrase in joined):
            n += 1
    return n


@router.patch("/loans/{loan_id}/payment")
def patch_payment(profile: CurrentProfile, loan_id: int, body: PaymentPatch) -> dict:
    """How the budget recognises this loan's installments (``loans set-payment``), then re-categorize
    when the budget module is on."""
    fields = body.model_fields_set & {"text", "iban"}
    if not fields:
        raise _invalid("give text or iban (an empty string clears it)")
    text = (body.text or "") if "text" in fields else None
    iban = (body.iban or "") if "iban" in fields else None
    if text is not None and len(text.strip()) > MAX_PHRASE:
        raise _invalid(f"text is longer than {MAX_PHRASE} characters")
    if iban is not None and iban.strip() and not 8 <= len(normalize_iban(iban)) <= 34:
        raise _invalid("iban is not an account number")
    if text is not None and text.strip() and not normalize_text(text):
        raise _invalid("text has no letters or digits")
    with get_session() as s:
        try:
            loan = set_payment_matching(s, loan_id, iban=iban, text=text, profile_id=profile.id)
        except ValueError:
            raise _error(404, "not_found", "No loan with this id in the profile") from None
        s.flush()
        matched = 0
        if "budget" in profiles.enabled_modules(s, profile.id):
            modules.recategorize(s, profile.id)
            s.flush()
            matched = _matched(s, profile.id, loan)
        loan = get_loan(s, loan_id, profile_id=profile.id)
        account = s.get(Account, loan.account_id)
        out = {
            "loan": loan_summary(s, loan, account, date.today()),  # noqa: DTZ011 - local dates
            "matched": matched,
        }
    return out
