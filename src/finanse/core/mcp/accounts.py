"""Generated account labels for MCP: ``"<institution> <type> <n>"`` (e.g. ``"mBank checking 1"``).

Stored account names are never sent (they are free text and often carry a person's name); the number
counts the profile's accounts of the same institution and type in creation order, so a label is
stable while accounts are only added.
"""

from __future__ import annotations

import re
from collections import defaultdict

from sqlmodel import Session, select

from .. import institutions, modules
from ..models import Account

_SAFE = re.compile(r"[^\w .&+-]")


def account_labels(session: Session, profile_id: int) -> dict[int, str]:
    modules.registry()  # institutions / account types of every module registered
    rows = session.exec(
        select(Account).where(Account.profile_id == profile_id).order_by(Account.id)
    ).all()
    seen: dict[tuple[str, str], int] = defaultdict(int)
    out: dict[int, str] = {}
    for acc in rows:
        inst = _SAFE.sub("", institutions.display_name(acc.bank or "manual")).strip() or "account"
        kind = str(acc.type or "other")
        seen[(inst, kind)] += 1
        out[acc.id] = f"{inst} {kind} {seen[(inst, kind)]}"
    return out
