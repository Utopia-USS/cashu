"""Assets API routes (profile-scoped): the profile's manually valued positions (F7 OB5).

- ``GET   /assets/manual``        every manual position and vehicle of the profile (active ones,
  largest value first): the core account row (``id``, ``bank``, ``name``, ``type``, ``currency``,
  ``iban_tail``, ``balance``, ``as_of``, ``is_liability``) plus ``kind`` ("manual" | "vehicle") and
  ``note`` (string | null).
- ``POST  /assets/manual``        ``{name, type, value, currency?, on_date?, note?}`` -> 201 the row;
  409 ``name_taken`` when the profile already has a manual position of that name.
- ``PATCH /assets/manual/{id}``   ``{note?, value?, on_date?}``: ``note: null`` (or blank) clears it;
  ``value`` records a new valuation (``on_date``, default today). 404 outside the profile.
- ``DELETE /assets/manual/{id}``  -> ``{id, removed: true}`` (F7 MB2): the position leaves every view
  and net worth (current and history) but stays stored for a restore. Idempotent; 404 outside the
  profile or for an unknown id.
- ``POST  /assets/manual/{id}/restore`` -> the row as ``GET`` returns it; restoring a position that is
  not removed returns it unchanged. No time window. 404 outside the profile or for an unknown id.

``note`` is one line, at most 500 characters (422 when longer). A vehicle row carries
``depreciation`` (``{purchase_price, purchase_date, annual_rate, floor}``, ``annual_rate`` a fraction:
0.15 = 15 %/yr; null without stored terms), every other row ``depreciation: null`` (F7 MB1). A removed
position answers 404 to ``PATCH``; a new position of a removed one's name starts a fresh account.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from finanse.core import account_types, networth
from finanse.core.accounts import upsert_balance
from finanse.core.api import CurrentProfile, account_row
from finanse.core.db import get_session
from finanse.core.institutions import MANUAL
from finanse.core.models import Account, Source

from . import service
from .models import Depreciation

router = APIRouter()

CREATE_TYPES = ("property", "investment", "other", "mortgage", "loan")
"""Types a manual position can be created with here (vehicles have their own depreciation terms)."""


class ManualCreate(BaseModel):
    name: str
    type: str
    value: float
    currency: str | None = None
    on_date: date | None = None
    note: str | None = None


class ManualPatch(BaseModel):
    note: str | None = None
    value: float | None = None
    on_date: date | None = None


def _422(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def _decimal(value: float) -> Decimal:
    try:
        out = Decimal(str(value))
    except InvalidOperation:
        raise _422("value must be a number") from None
    if not out.is_finite() or out < 0:
        raise _422("value must be a number >= 0")
    return out


def _is_vehicle(account: Account) -> bool:
    return (account.external_id or "").startswith("vehicle:")


def _depreciation(dep: Depreciation | None) -> dict | None:
    """The stored curve in the API's shape: the stored rate is a percentage (15 = 15 %/yr), the API's
    ``annual_rate`` a fraction (0.15)."""
    if dep is None:
        return None
    return {
        "purchase_price": float(dep.purchase_price),
        "purchase_date": dep.purchase_date.isoformat(),
        "annual_rate": float(Decimal(dep.annual_rate) / 100),
        "floor": None if dep.floor is None else float(dep.floor),
    }


def _curves(session: Session, accounts: list[Account]) -> dict[int, Depreciation]:
    ids = [a.id for a in accounts if _is_vehicle(a)]
    if not ids:
        return {}
    rows = session.exec(select(Depreciation).where(Depreciation.account_id.in_(ids))).all()
    return {d.account_id: d for d in rows}


def _rows(session: Session, profile_id: int) -> list[dict]:
    _totals, lines = networth.net_worth(session, profile_id=profile_id)  # removed ones left out
    lines = [ln for ln in lines if service.is_module_account(ln.account)]
    notes = service.notes(session, [ln.account.id for ln in lines])
    curves = _curves(session, [ln.account for ln in lines])
    out = [
        account_row(ln.account, ln.contribution, ln.as_of)
        | {
            "kind": "vehicle" if _is_vehicle(ln.account) else "manual",
            "note": notes.get(ln.account.id),
            "depreciation": _depreciation(curves.get(ln.account.id)),
        }
        for ln in lines
    ]
    return sorted(out, key=lambda r: (-(abs(r["balance"]) if r["balance"] is not None else 0), r["name"]))


def _row(session: Session, profile_id: int, account_id: int) -> dict:
    return next(r for r in _rows(session, profile_id) if r["id"] == account_id)


def _account(
    session: Session, profile_id: int, account_id: int, *, removed: bool = False
) -> Account:
    """A manual position or vehicle of the profile; 404 otherwise (and for a removed one unless
    ``removed``: delete / restore address removed positions too)."""
    acc = session.get(Account, account_id)
    if (
        acc is None
        or acc.profile_id != profile_id
        or not service.is_module_account(acc)
        or (acc.removed_at is not None and not removed)
    ):
        raise HTTPException(status_code=404, detail="No manual position with this id in the profile")
    return acc


@router.get("/assets/manual")
def manual_positions(profile: CurrentProfile) -> list[dict]:
    with get_session() as s:
        return _rows(s, profile.id)


@router.post("/assets/manual", status_code=201)
def create_manual_position(profile: CurrentProfile, body: ManualCreate) -> dict:
    name = " ".join((body.name or "").split())
    if not name or len(name) > 120:
        raise _422("name is required (max 120 characters)")
    if body.type not in CREATE_TYPES or body.type not in account_types.ids():
        raise _422(f"type must be one of: {', '.join(t for t in CREATE_TYPES if t in account_types.ids())}")
    currency = (body.currency or profile.base_currency or "PLN").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise _422("currency must be a 3-letter code")
    value = _decimal(body.value)
    try:
        service.clean_note(body.note)
    except service.AssetError as e:
        raise _422(str(e)) from None
    with get_session() as s:
        taken = s.exec(
            select(Account.id).where(
                Account.profile_id == profile.id,
                Account.bank == MANUAL,
                Account.external_id == f"manual:{name}",
                Account.removed_at.is_(None),  # a removed one's name is free again
            )
        ).first()
        if taken is not None:
            raise HTTPException(
                status_code=409,
                detail="A manual position with this name already exists",
                headers={"X-Finanse-Error-Code": "name_taken"},
            )
        acc = service.add_manual_position(
            s,
            name=name,
            type=body.type,
            value=value,
            currency=currency,
            on_date=body.on_date,
            profile_id=profile.id,
            note=body.note,
        )
        s.commit()
        return _row(s, profile.id, acc.id)


@router.patch("/assets/manual/{account_id}")
def patch_manual_position(profile: CurrentProfile, account_id: int, body: ManualPatch) -> dict:
    fields = body.model_fields_set
    with get_session() as s:
        acc = _account(s, profile.id, account_id)
        if "value" in fields and body.value is not None:
            if acc.external_id.startswith("vehicle:"):
                raise _422("a vehicle's value follows its depreciation terms")
            upsert_balance(
                s, acc, body.on_date or date.today(),  # noqa: DTZ011 - local dates
                _decimal(body.value), source=Source.MANUAL,
            )
        if "note" in fields:
            try:
                service.set_note(s, acc, body.note)
            except service.AssetError as e:
                raise _422(str(e)) from None
        s.commit()
        return _row(s, profile.id, acc.id)


@router.delete("/assets/manual/{account_id}")
def remove_manual_position(profile: CurrentProfile, account_id: int) -> dict:
    with get_session() as s:
        acc = _account(s, profile.id, account_id, removed=True)
        service.remove(s, acc)
        s.commit()
        return {"id": acc.id, "removed": True}


@router.post("/assets/manual/{account_id}/restore")
def restore_manual_position(profile: CurrentProfile, account_id: int) -> dict:
    with get_session() as s:
        acc = _account(s, profile.id, account_id, removed=True)
        service.restore(s, acc)
        s.commit()
        row = next((r for r in _rows(s, profile.id) if r["id"] == acc.id), None)
        if row is None:  # deactivated (``active`` off): GET does not list it, same shape anyway
            row = account_row(acc, None, None) | {
                "kind": "vehicle" if _is_vehicle(acc) else "manual",
                "note": service.notes(s, [acc.id]).get(acc.id),
                "depreciation": _depreciation(_curves(s, [acc]).get(acc.id)),
            }
        return row
