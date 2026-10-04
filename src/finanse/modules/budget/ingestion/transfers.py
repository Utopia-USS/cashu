"""Cross-reference internal transfers between the user's own accounts.

When money moves from mBank to Erste, both banks report a transaction: an
outflow on one side and an inflow on the other. These are not real income or
expense — they must be flagged so monthly spending/income stats don't double
count them (net worth is unaffected either way).

Matching is deliberately conservative: an amount + date match alone is treated
as coincidence unless there's a counterparty signal (the other account's IBAN,
or a name pointing at the other bank/account holder).
"""

from __future__ import annotations

from collections import defaultdict
from uuid import uuid4

from sqlmodel import Session

from finanse.core import profiles
from finanse.core.accounts import profile_accounts
from finanse.core.models import Account

from ..models import Transaction
from ..queries import transactions
from .normalize import iban_key


def reset_transfer_matches(session: Session, *, profile_id: int | None = None) -> int:
    """Clear the profile's transfer groupings (so matching can be recomputed)."""
    pid = profiles.scope(session, profile_id)
    txns = session.exec(
        transactions(pid, Transaction.transfer_group_id.is_not(None))  # type: ignore[union-attr]
    ).all()
    for t in txns:
        t.transfer_group_id = None
        t.is_internal_transfer = False
        session.add(t)
    return len(txns)


def _pair_score(out: Transaction, inc: Transaction, accounts: dict[int, Account]) -> int | None:
    """Return a confidence score for (out, inc) being two legs of one transfer.

    Only the IBAN signal is trusted: the counterparty account number on one leg
    must equal the *other* account's own IBAN. A name/amount coincidence is not
    enough — bank fee descriptions routinely contain the bank's own name, so a
    name-based match would wrongly hide real expenses from spending stats.
    """
    out_acc = accounts.get(out.account_id)
    inc_acc = accounts.get(inc.account_id)

    out_cp_iban = iban_key(out.counterparty_iban)
    inc_cp_iban = iban_key(inc.counterparty_iban)
    out_iban = iban_key(out_acc.iban) if out_acc else ""
    inc_iban = iban_key(inc_acc.iban) if inc_acc else ""

    if (out_cp_iban and out_cp_iban == inc_iban) or (inc_cp_iban and inc_cp_iban == out_iban):
        return 3

    return None


def match_internal_transfers(
    session: Session, *, max_days: int = 3, profile_id: int | None = None
) -> int:
    """Find and flag internal-transfer pairs among the profile's currently
    ungrouped rows (both legs must be accounts of the same profile).

    Returns the number of pairs matched.
    """
    pid = profiles.scope(session, profile_id)
    accounts = {a.id: a for a in profile_accounts(session, pid)}

    ungrouped = session.exec(
        transactions(pid, Transaction.transfer_group_id.is_(None))  # type: ignore[union-attr]
    ).all()

    inflows_by_amount: dict[str, list[Transaction]] = defaultdict(list)
    for t in ungrouped:
        if t.amount > 0:
            inflows_by_amount[f"{t.amount:.2f}"].append(t)

    matched: set[int] = set()
    pairs = 0

    outflows = sorted(
        (t for t in ungrouped if t.amount < 0),
        key=lambda t: (t.booking_date, t.id or 0),
    )

    for out in outflows:
        if out.id in matched:
            continue
        key = f"{-out.amount:.2f}"
        best: tuple[Transaction, int, int] | None = None  # (inc, score, day_diff)
        for inc in inflows_by_amount.get(key, []):
            if inc.id in matched or inc.account_id == out.account_id:
                continue
            day_diff = abs((inc.booking_date - out.booking_date).days)
            if day_diff > max_days:
                continue
            score = _pair_score(out, inc, accounts)
            if score is None:
                continue
            if best is None or (score, -day_diff) > (best[1], -best[2]):
                best = (inc, score, day_diff)

        if best is not None:
            inc = best[0]
            gid = uuid4().hex
            for t in (out, inc):
                t.transfer_group_id = gid
                t.is_internal_transfer = True
                session.add(t)
            matched.add(out.id)  # type: ignore[arg-type]
            matched.add(inc.id)  # type: ignore[arg-type]
            pairs += 1

    return pairs
