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
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlmodel import Session, select

from ..models import Transaction
from .normalize import RawTransaction, base_hash, to_transaction


@dataclass
class DedupResult:
    to_insert: list[Transaction] = field(default_factory=list)
    num_duplicates: int = 0

    @property
    def num_inserted(self) -> int:
        return len(self.to_insert)


def prepare_new_transactions(
    session: Session,
    account_id: int,
    raws: list[RawTransaction],
    import_batch_id: int | None = None,
) -> DedupResult:
    """Filter `raws` against what's already stored and return rows to insert."""
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

    for rt in raws:
        h = base_hash(account_id, rt)

        if rt.bank_transaction_id and rt.bank_transaction_id in existing_btids:
            # That stored row is accounted for: consume its content-hash slot too,
            # or an identical same-day transaction with a new id would be taken
            # for its duplicate and dropped.
            used[existing_btids[rt.bank_transaction_id]] += 1
            result.num_duplicates += 1
            continue

        if used[h] < existing_hash_counts.get(h, 0):
            used[h] += 1
            result.num_duplicates += 1
            continue

        occurrence = existing_hash_counts.get(h, 0) + created[h]
        created[h] += 1
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
