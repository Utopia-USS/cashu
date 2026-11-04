"""Synthetic Python match-transfers command oracle for the native host test."""

import datetime as dt
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

from cashu.core.paths import data_dir

assert os.environ.get("CASHU_TESTING") == "1"
assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()

from sqlmodel import select

from cashu.core.db import get_session, init_db
from cashu.core.models import Account, Source
from cashu.core.profiles import create_profile
from cashu.modules.budget.ingestion.transfers import match_internal_transfers, reset_transfer_matches
from cashu.modules.budget.models import Transaction


def nrb(bban):
    return f"{98 - int(f'{bban}252100') % 97:02d}{bban}"


n1 = nrb("114000000000000000000001")
n2 = nrb("114000000000000000000002")
rows = [
    ("two-out", 0, "2026-10-01", "-10.00", n2, "two"),
    ("same-out", 0, "2026-10-04", "-20.00", n2, "same"),
    ("two-in", 1, "2026-10-03", "10.00", None, "two"),
    ("same-in", 1, "2026-10-04", "20.00", None, "same"),
]

init_db()
with get_session() as session:
    profile = create_profile(session, name="Synthetic", slug="synthetic", modules_=["budget"])
    accounts = [
        Account(profile_id=profile.id, bank="mbank", name="Synthetic A", iban=n1),
        Account(profile_id=profile.id, bank="erste", name="Synthetic B", iban=n2),
    ]
    session.add_all(accounts)
    session.flush()
    for label, account, date, amount, counterparty, group in rows:
        session.add(
            Transaction(
                account_id=accounts[account].id,
                booking_date=dt.date.fromisoformat(date),
                amount=Decimal(amount),
                currency="PLN",
                counterparty_iban=counterparty,
                reference=label,
                source=Source.CSV,
                dedup_hash=label,
                transfer_group_id=group,
                is_internal_transfer=True,
            )
        )
    session.commit()

    results = []
    for case in json.load(sys.stdin):
        cleared = reset_transfer_matches(session, profile_id=profile.id) if case["reset"] else 0
        matched = match_internal_transfers(
            session, profile_id=profile.id, max_days=case["maxDays"]
        )
        session.commit()
        txns = session.exec(
            select(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .where(Account.profile_id == profile.id)
            .order_by(Transaction.reference)
        ).all()
        groups = {}
        ungrouped = []
        for txn in txns:
            if txn.transfer_group_id is None:
                assert not txn.is_internal_transfer
                ungrouped.append(txn.reference)
            else:
                assert txn.is_internal_transfer
                groups.setdefault(txn.transfer_group_id, []).append(txn.reference)
        results.append(
            {
                "cleared": cleared,
                "matched": matched,
                "pairs": sorted(sorted(group) for group in groups.values()),
                "ungrouped": sorted(ungrouped),
            }
        )
print(json.dumps(results))
