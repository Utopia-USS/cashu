#!/usr/bin/env python3
"""Synthetic parity vectors for the investments dedup key builders (scope S26, commit C2).

    .venv/bin/python parity/python/vectors_inv_dedup.py            # writes the vectors
    .venv/bin/python parity/python/vectors_inv_dedup.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/inv-dedup.jsonl``, read by
``packages/domain/src/investments/dedupKey.test.ts``. Every input is synthetic (hand-picked edge cases
plus random rows from small pools with a fixed seed, so keys collide and occurrences count up);
nothing reads a data dir or a database. The oracles are the real Python functions of
``importing/dedup.py`` (``dedup_hash``, ``dedup_hashes``, ``reconciliation_hash``,
``DedupInput.from_parsed``) and ``importing/resolver.py`` (``_HintKey.of`` for the broker symbol and
ISIN of a row). The exact message each hash covers is captured from ``dedup.py`` itself (its
``hashlib`` is wrapped while generating), never re-built here.

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then one JSON array per vector
(layout in ``meta.layout``). Decimals are ``str(Decimal)`` text, dates ISO, a row is an object with
the ``ParsedTxn`` fields the hash reads plus ``instrument_key`` (the v1 local id, null for cash).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from pathlib import Path

from cashu.modules.investments.domain import Currency, TxnType
from cashu.modules.investments.importing import dedup
from cashu.modules.investments.importing.contract import ParsedTxn
from cashu.modules.investments.importing.resolver import InstrumentHint, _HintKey

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "domain" / "test" / "vectors" / "inv-dedup.jsonl"
SEED = 26_02
LAYOUT = (
    "['file', account_id, broker_id, [row], [message], [sha256]] (dedup_hashes over "
    "DedupInput.from_parsed) | ['hash', input, account_id, broker_id, occurrence, message, sha256] "
    "(dedup_hash over a DedupInput as given, no abs) | ['recon', account_id, instrument_id, as_of, "
    "type, quantity, message, sha256] | ['ikey', {symbol, isin, name}, namespace, broker_symbol | "
    "null, isin | null, v2 instrument key]"
)


class _Recorder:
    """Stands in for ``hashlib`` inside ``dedup.py``: records every hashed message."""

    def __init__(self) -> None:
        self.messages: list[str] = []

    def sha256(self, data: bytes):
        self.messages.append(data.decode("utf-8"))
        return hashlib.sha256(data)


def _captured(fn):
    """Runs ``fn`` with ``dedup.hashlib`` wrapped; returns (result, messages)."""
    recorder = _Recorder()
    real = dedup.hashlib
    dedup.hashlib = recorder
    try:
        return fn(), recorder.messages
    finally:
        dedup.hashlib = real


def _dec(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _row(
    trade_date: str,
    txn_type: TxnType,
    gross: str,
    cash: str,
    *,
    ref: str | None = None,
    instrument_key: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    currency: str = "PLN",
) -> dict:
    return {
        "trade_date": trade_date,
        "type": txn_type.value,
        "gross_amount": gross,
        "cash_amount": cash,
        "external_ref": ref,
        "instrument_key": instrument_key,
        "quantity": quantity,
        "price": price,
        "currency": currency,
    }


def _parsed(index: int, row: dict) -> ParsedTxn:
    return ParsedTxn(
        row_index=index,
        trade_date=date.fromisoformat(row["trade_date"]),
        type=TxnType(row["type"]),
        currency=Currency(row["currency"]),
        gross_amount=Decimal(row["gross_amount"]),
        cash_amount=Decimal(row["cash_amount"]),
        cash_currency=Currency(row["currency"]),
        external_ref=row["external_ref"],
        quantity=None if row["quantity"] is None else Decimal(row["quantity"]),
        price=None if row["price"] is None else Decimal(row["price"]),
    )


def file_vector(account_id: str, broker_id: str, rows: list[dict]) -> list:
    inputs = [
        dedup.DedupInput.from_parsed(_parsed(i, row), row["instrument_key"])
        for i, row in enumerate(rows)
    ]
    hashes, messages = _captured(
        lambda: dedup.dedup_hashes(inputs, account_id=account_id, broker_id=broker_id)
    )
    assert len(messages) == len(hashes)
    return ["file", account_id, broker_id, rows, messages, list(hashes)]


B, S, DIV, DEP, FEE = TxnType.BUY, TxnType.SELL, TxnType.DIVIDEND, TxnType.DEPOSIT, TxnType.FEE


def hand_files() -> list[list]:
    """Edge cases: refs (partial fills sharing one ref, identical fills, strip, blank), content rows,
    decimal value equality, copy_abs of negative quantity / gross, cash rows, the legacy broker."""
    refs = [
        _row("2026-01-05", DEP, "0", "1000.00", ref="D-1"),
        _row("2026-01-07", B, "500.00", "-501.00", ref="O-7", instrument_key="3", quantity="10",
             price="50.00"),
        _row("2026-01-07", B, "250.00", "-250.50", ref="O-7", instrument_key="3", quantity="5",
             price="50.00"),
        _row("2026-01-07", B, "250.00", "-250.50", ref="O-7", instrument_key="3", quantity="5",
             price="50"),  # same fill by value: occurrence 1
        _row("2026-01-08", B, "250.00", "-250.70", ref="  O-7 ", instrument_key="3", quantity="5.0",
             price="5E+1"),  # stripped ref, exponent price: occurrence 2
        _row("2026-01-09", FEE, "1.00", "-1.00", ref="O-7"),  # fee row of the order, cash row
        _row("2026-01-09", S, "-120.00", "119.00", ref=" S-1 ", instrument_key="4",
             quantity="-2", price="60"),  # negative quantity / gross: copy_abs; NBSP / em space strip
        _row("2026-01-10", DIV, "12.00", "10.20", ref="   ", instrument_key="3"),  # blank ref: content
        _row("2026-01-10", DIV, "12.0", "10.2", ref="", instrument_key="3"),  # same content by value
    ]
    content = [
        _row("2026-02-01", B, "105.00", "-105.00", instrument_key="7", quantity="10.50",
             price="10"),
        _row("2026-02-01", B, "105", "-105.0", instrument_key="7", quantity="10.5", price="10.000"),
        _row("2026-02-01", B, "105", "-105", instrument_key="7", quantity="10.5", price="10",
             currency="EUR"),  # currency is not in the content key: occurrence 2
        _row("2026-02-02", B, "1E+2", "-1E+2", instrument_key="7", quantity="1E+1", price="10"),
        _row("2026-02-02", B, "100", "-100", instrument_key="7", quantity="10", price="10"),
        _row("2026-02-03", S, "-0", "0", instrument_key="8", quantity="-0.000", price="0"),
        _row("2026-02-04", DEP, "0", "-0", quantity=None),
        _row("2026-02-04", DEP, "0", "0.00"),
        _row("2026-02-05", B, "0.000000000000000000001", "-0.000000000000000000001",
             instrument_key="9", quantity="1", price="0.000000000000000000001"),
        _row("2026-02-06", FEE, "2.5", "-2.5", instrument_key=""),  # "" instrument key = cash
    ]
    return [
        file_vector("1", "examplebroker", refs),
        file_vector("1", "cashu", refs),  # legacy rename: hashes under "finanse"
        file_vector("1", "finanse", refs),
        file_vector("12", "generic_csv", content),
        file_vector("12", "cashu", content),
    ]


def random_files(rng: random.Random) -> list[list]:
    """Rows from small pools so occurrence keys repeat within a file."""
    types = [B, S, DIV, DEP, FEE, TxnType.TAX, TxnType.SPLIT, TxnType.TRANSFER_IN]
    amounts = ["10", "10.0", "10.50", "-10.5", "1E+1", "0", "-0", "123.456", "0.01", "2.50E-1"]
    refs = [None, None, "", " ", "R-1", " R-1", "R-2", "X　", "Ż-9"]
    keys = [None, "", "1", "2", "15"]
    dates = ["2026-03-01", "2026-03-02", "2025-12-31"]
    out = []
    for n in range(12):
        rows = []
        for _ in range(rng.randint(5, 40)):
            key = rng.choice(keys)
            cash_row = key is None or key == ""
            rows.append(
                _row(
                    rng.choice(dates),
                    rng.choice(types),
                    rng.choice(amounts),
                    rng.choice(amounts),
                    ref=rng.choice(refs),
                    instrument_key=key,
                    quantity=None if cash_row and rng.random() < 0.7 else rng.choice(amounts),
                    price=None if rng.random() < 0.3 else rng.choice(amounts),
                    currency=rng.choice(["PLN", "USD"]),
                )
            )
        broker = ["xtb", "cashu", "finanse", "generic_csv"][n % 4]
        out.append(file_vector(str(rng.randint(1, 30)), broker, rows))
    return out


def hash_vectors() -> list[list]:
    """``dedup_hash`` on inputs as given (``from_transaction`` keeps the stored values)."""
    cases = [
        (dedup.DedupInput(trade_date=date(2026, 4, 1), type=S, gross_amount=Decimal(-30),
                          cash_amount=Decimal("29.5"), external_ref=None, instrument_key="5",
                          quantity=Decimal(-3), price=Decimal(10)), "9", "xtb", 0),
        (dedup.DedupInput(trade_date=date(2026, 4, 1), type=B, gross_amount=Decimal(30),
                          cash_amount=Decimal(-30), external_ref=" T-1 ", instrument_key="5",
                          quantity=Decimal(3), price=None, currency=None), "9", "cashu", 7),
        (dedup.DedupInput(trade_date=date(2026, 4, 2), type=DEP, gross_amount=Decimal(0),
                          cash_amount=Decimal(100), external_ref=None), "9", "manual", 1000),
    ]
    out = []
    for row, account, broker, k in cases:
        digest, messages = _captured(
            lambda row=row, account=account, broker=broker, k=k: dedup.dedup_hash(
                row, account_id=account, broker_id=broker, occurrence=k
            )
        )
        record = {
            "trade_date": row.trade_date.isoformat(),
            "type": row.type.value,
            "gross_amount": _dec(row.gross_amount),
            "cash_amount": _dec(row.cash_amount),
            "external_ref": row.external_ref,
            "instrument_key": row.instrument_key,
            "quantity": _dec(row.quantity),
            "price": _dec(row.price),
            "currency": row.currency,
        }
        out.append(["hash", record, account, broker, k, messages[0], digest])
    return out


def recon_vectors() -> list[list]:
    cases = [
        ("4", "11", "2026-02-27", TxnType.ADJUSTMENT, "5"),
        ("4", "11", "2026-02-27", TxnType.TRANSFER_OUT, "2.500"),
        ("4", "12", "2026-03-31", TxnType.TRANSFER_OUT, "1E+1"),
    ]
    out = []
    for account, instrument, as_of, txn_type, quantity in cases:
        digest, messages = _captured(
            lambda a=account, i=instrument, d=as_of, t=txn_type, q=quantity: dedup.reconciliation_hash(
                a, i, date.fromisoformat(d), t, Decimal(q)
            )
        )
        out.append(["recon", account, instrument, as_of, txn_type.value, quantity, messages[0], digest])
    return out


def ikey_vectors() -> list[list]:
    """The v2 instrument key of a parsed row (gid.md 4.6) from the resolver's own hint key."""
    cases = [
        ({"symbol": "ABC", "isin": "PLABC0000016", "name": "ABC Example SA"}, "examplebroker"),
        ({"symbol": " PKN.PL ", "isin": None, "name": None}, "xtb"),
        ({"symbol": None, "isin": "pl0000000002", "name": "Only Name Fund"}, "generic_csv"),
        ({"symbol": "", "isin": " ie00test0001 ", "name": "  "}, "generic_csv"),
        ({"symbol": " ", "isin": None, "name": " Nazwa Ź "}, "cashu"),
        ({"symbol": None, "isin": None, "name": None}, "cashu"),
        ({"symbol": " ", "isin": "", "name": ""}, "xtb"),
        ({"symbol": "BTC/USD", "isin": None, "name": None}, "exchange"),
        ({"symbol": "straße", "isin": "de000test0001", "name": None}, "finanse"),
    ]
    out = []
    for fields, namespace in cases:
        key = _HintKey.of(InstrumentHint(currency=Currency.PLN, **fields))
        if key.broker_symbol is not None:
            ikey = f"{namespace}:{key.broker_symbol}"
        elif key.isin is not None:
            ikey = f"isin:{key.isin}"
        else:
            ikey = ""
        out.append(["ikey", fields, namespace, key.broker_symbol, key.isin, ikey])
    return out


def render() -> bytes:
    rows = [
        *hand_files(),
        *random_files(random.Random(SEED)),
        *hash_vectors(),
        *recon_vectors(),
        *ikey_vectors(),
    ]
    meta = {
        "meta": {
            "name": "inv-dedup",
            "count": len(rows),
            "layout": LAYOUT,
            "seed": SEED,
            "generator": "parity/python/vectors_inv_dedup.py",
            "python": sys.version.split()[0],
        }
    }
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
    return ("\n".join(lines) + "\n").encode("utf-8")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    content = render()
    if args.check:
        if not OUT.exists() or OUT.read_bytes() != content:
            print(f"stale: {OUT.relative_to(ROOT)}")
            return 1
        print("up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(content)
    print(f"{OUT.relative_to(ROOT)} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
