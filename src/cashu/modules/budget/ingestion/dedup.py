"""Deduplication when persisting raw transactions.

Two independent problems are handled:

1. **Re-import idempotency** — the same source pulled twice (e.g. daily Open
   Banking sync over overlapping windows). Caught by the bank-provided
   transaction id when present.

2. **Cross-source overlap** — CSV backfill and Open Banking both cover the last
   ~90 days. The same real transaction must not be counted twice. Caught by a
   content hash. Genuinely identical same-day transactions are preserved via an
   `occurrence` index: incoming rows first "consume" matching rows already in
   the DB (treated as duplicates); only the surplus becomes new rows.

3. **The newest-day rule** (``newest_day_rule=True``; Open Banking sync, cashu-format
   documents and connectors) - another source describes the same transaction with
   other texts (a card payment's memo differs between the bank CSV, Open Banking and
   a converter), so the content hash cannot match it. What is already stored is
   authoritative up to the account's newest stored day: an incoming row the id and
   the content hash did not match is ``overlap`` (not inserted) when it is older than
   that day; on that day it first consumes a stored row of the same amount that no
   incoming row matched (a multiset: two identical payments stay two); only the
   surplus and the rows after that day are new.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from sqlmodel import Session, select

from ..models import Transaction
from .normalize import RawTransaction, base_hash, to_transaction


@dataclass
class DedupResult:
    to_insert: list[Transaction] = field(default_factory=list)
    num_duplicates: int = 0
    # Rows the newest-day rule left out (stored history from another source covers them).
    num_overlap: int = 0
    # Per incoming raw row, in order: "new" | "duplicate" | "overlap" (the import preview's row status).
    statuses: list[str] = field(default_factory=list)

    @property
    def num_inserted(self) -> int:
        return len(self.to_insert)


def prepare_new_transactions(
    session: Session,
    account_id: int,
    raws: list[RawTransaction],
    import_batch_id: int | None = None,
    *,
    newest_day_rule: bool = False,
) -> DedupResult:
    """Filter `raws` against what's already stored and return rows to insert (see the module doc;
    ``newest_day_rule``: point 3)."""
    existing = session.exec(
        select(Transaction).where(Transaction.account_id == account_id)
    ).all()

    # bank transaction id -> content hash of the stored row carrying it
    existing_btids = {t.bank_transaction_id: t.dedup_hash for t in existing if t.bank_transaction_id}
    existing_hash_counts: dict[str, int] = defaultdict(int)
    for t in existing:
        existing_hash_counts[t.dedup_hash] += 1

    used: dict[str, int] = defaultdict(int)     # incoming matched to existing rows
    created: dict[str, int] = defaultdict(int)  # new occurrences added this batch
    result = DedupResult()

    # Pass 1: the bank id, then the content hash.
    hashes: list[str] = []
    matched: list[bool] = []
    for rt in raws:
        h = base_hash(account_id, rt)
        hashes.append(h)
        if rt.bank_transaction_id and rt.bank_transaction_id in existing_btids:
            # That stored row is accounted for: consume its content-hash slot too,
            # or an identical same-day transaction with a new id would be taken
            # for its duplicate and dropped.
            used[existing_btids[rt.bank_transaction_id]] += 1
            matched.append(True)
        elif used[h] < existing_hash_counts.get(h, 0):
            used[h] += 1
            matched.append(True)
        else:
            matched.append(False)

    # Pass 2 (newest-day rule): the stored rows of the newest day no incoming row matched.
    latest = max((t.booking_date for t in existing), default=None) if newest_day_rule else None
    spare: Counter[str] = Counter()
    if latest is not None:
        on_latest: dict[str, Transaction] = {
            t.dedup_hash: t for t in existing if t.booking_date == latest
        }
        for h, t in on_latest.items():
            free = existing_hash_counts[h] - min(used[h], existing_hash_counts[h])
            if free > 0:
                spare[f"{t.amount:.2f}"] += free

    for rt, h, was_matched in zip(raws, hashes, matched, strict=True):
        if was_matched:
            result.num_duplicates += 1
            result.statuses.append("duplicate")
            continue
        if latest is not None and rt.booking_date <= latest:
            key = f"{rt.amount:.2f}"
            if rt.booking_date < latest or spare[key] > 0:
                if rt.booking_date == latest:
                    spare[key] -= 1  # its twin from another source is already stored
                result.num_overlap += 1
                result.statuses.append("overlap")
                continue
        occurrence = existing_hash_counts.get(h, 0) + created[h]
        created[h] += 1
        result.statuses.append("new")
        result.to_insert.append(
            to_transaction(
                rt,
                account_id=account_id,
                dedup_hash=h,
                occurrence=occurrence,
                import_batch_id=import_batch_id,
            )
        )

    return result
