"""Budget ingestion checks (scope S07): the v2 content hash and occurrence of stored rows
(``budget.dedup``) and the bank parsers plus dedup on the synthetic CSV fixtures
(``budget.ingest_fixtures``, not dataset-bound).

Detection is deliberately not in these goldens: the TS port fixes quirk Q4 (quoted Erste exports),
pinned by ``registry.vectors.test.ts`` instead.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from . import Check, Ctx

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "packages" / "domain" / "test" / "fixtures" / "budget-csv"
BANKS = ("mbank", "erste", "pekao")
_HEX40 = re.compile(r"^[0-9a-f]{40}$")
# Exception class -> the TS port's refusal reason (the oracle side names the outcome, the port emits it).
_REASONS = {
    "ValueError": "no_header",
    "InvalidOperation": "bad_amount",
    "UnicodeDecodeError": "undecodable",
    "Error": "bad_csv",
}


def _content_key(t) -> str:
    """The v2 content key from STORED columns (``normalize.base_hash`` minus the account prefix)."""
    from cashu.core.text import iban_key, normalize_text

    memo = " ".join(p for p in (t.description, t.reference) if p)
    counterparty = iban_key(t.counterparty_iban) or normalize_text(t.counterparty_name)
    return "|".join(
        [t.booking_date.isoformat(), f"{t.amount:.2f}", t.currency.upper(), counterparty,
         normalize_text(memo)]
    )


def dedup(ctx: Ctx) -> dict:
    from sqlmodel import select

    from cashu.core.models import Account
    from cashu.modules.budget.models import Transaction

    out = {}
    for p in ctx.with_module("budget"):
        rows = ctx.session.exec(
            select(Transaction)
            .join(Account, Account.id == Transaction.account_id)
            .where(Account.profile_id == p.id)
            .order_by(Transaction.account_id, Transaction.id)
        ).all()
        accounts: dict[str, dict] = {}
        for t in rows:
            acc = accounts.setdefault(ctx.ids.key("accounts", t.account_id), {"rows": [], "non_content_rows": 0})
            if not _HEX40.match(t.dedup_hash):
                acc["non_content_rows"] += 1
                continue
            key = _content_key(t)
            acc["rows"].append({
                "booking_date": t.booking_date,
                "hash_v2": hashlib.sha1(key.encode("utf-8")).hexdigest(),
                "occurrence": t.occurrence,
                "v1_ok": hashlib.sha1(f"{t.account_id}|{key}".encode()).hexdigest() == t.dedup_hash,
            })
        out[ctx.pkey(p)] = accounts
    return out


def _statement(stmt) -> dict:
    def v2(t) -> str:
        return hashlib.sha1(_raw_key(t).encode("utf-8")).hexdigest()

    return {
        "bank": stmt.bank,
        "account_number": stmt.account_number,
        "currency": stmt.currency,
        "skipped_rows": stmt.skipped_rows,
        "balances": [{"date": d, "amount": a} for d, a in stmt.balances],
        "transactions": [
            {
                "booking_date": t.booking_date,
                "value_date": t.value_date,
                "amount": t.amount,
                "currency": t.currency,
                "counterparty_name": t.counterparty_name,
                "counterparty_iban": t.counterparty_iban,
                "description": t.description,
                "reference": t.reference,
                "raw": t.raw,
                "hash_v2": v2(t),
            }
            for t in stmt.transactions
        ],
    }


def _raw_key(rt) -> str:
    from cashu.core.text import iban_key, normalize_text

    counterparty = iban_key(rt.counterparty_iban) or normalize_text(rt.counterparty_name)
    return "|".join([rt.booking_date.isoformat(), f"{rt.amount:.2f}", rt.currency.upper(), counterparty,
                     normalize_text(rt.memo)])


def _own_bank(rel: str) -> str | None:
    folder, name = rel.split("/", 1)
    if folder in BANKS:
        return folder
    if folder == "oracle":
        return "pekao" if "pekao" in name else "mbank"
    return None


def _round_trip(raws) -> list[dict]:
    """Three imports of the same rows on a fresh in-memory account: plain, again, newest-day rule."""
    from sqlmodel import Session, SQLModel, create_engine

    from cashu.modules.budget.ingestion.dedup import prepare_new_transactions

    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    out = []
    with Session(engine) as session:
        for rule in (False, False, True):
            result = prepare_new_transactions(session, 1, raws, newest_day_rule=rule)
            new = iter(result.to_insert)
            out.append({
                "statuses": result.statuses,
                "rows": [
                    {"hash_v2": hashlib.sha1(_raw_key(r).encode("utf-8")).hexdigest(),
                     "occurrence": next(new).occurrence}
                    for r, s in zip(raws, result.statuses, strict=True) if s == "new"
                ],
            })
            for t in result.to_insert:
                session.add(t)
            session.commit()
    engine.dispose()
    return out


def ingest_fixtures(_ctx: Ctx) -> list[dict]:
    from cashu.modules.budget.ingestion.csv_import import get_importer

    out = []
    for path in sorted(p for p in FIXTURES.rglob("*.csv") if p.is_file()):
        rel = path.relative_to(FIXTURES).as_posix()
        forced = {}
        parsed = {}
        for bank in BANKS:
            try:
                stmt = get_importer(bank).parse(path)
            except Exception as e:  # noqa: BLE001 - the refusal is the compared outcome
                forced[bank] = {"error": _REASONS.get(type(e).__name__, type(e).__name__)}
                continue
            parsed[bank] = stmt
            forced[bank] = _statement(stmt)
        own = _own_bank(rel)
        trip = _round_trip(parsed[own].transactions) if own in parsed else None
        out.append({"file": rel, "forced": forced, "round_trip": trip})
    return out


CHECKS = [
    Check("budget.dedup", dedup),
    Check("budget.ingest_fixtures", ingest_fixtures, per_profile=False),
]
