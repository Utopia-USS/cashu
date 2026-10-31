#!/usr/bin/env python3
"""Inputs of the investments content-hash parity gate (scope S26, LEAD DECISION): synthetic broker
files imported through the REAL Python import service into a temp data dir.

    .venv/bin/python parity/python/inv_hash_parity.py            # writes the fixture
    .venv/bin/python parity/python/inv_hash_parity.py --check    # regenerates in memory, fails on any diff

The gate: dedupHashV2 rebuilt by genesis from the stored rows equals the dedupHashV2 a TS re-import of
the same file computes. This harness writes both sides' inputs to
``packages/store/src/genesis/testing/invHashParity.json``. Every value is synthetic (the canonical
files below and the generic CSV fixture of ``tests/investments/importing/imp_support.py``); the data
dir, workspaces, HOME and launch agents point into a temp dir (refused otherwise) and the clock is
frozen (``frozen.py``), so two runs write identical bytes.

Fixture format (JSON object):

- ``meta``: ``generator``, ``alembic_version``, ``frozen_clock`` (UTC).
- ``imports``: one entry per import, in commit order:
  ``name`` (file name), ``importer`` (stored ``inv_import_batches.importer``), ``brokerId``
  (``contract.effective_broker_id``: the alias namespace and the stored batch ``broker``; the hash
  uses its legacy rename; a re-import uses it), ``storedBroker`` (the ``broker`` the stored batch
  holds: ``brokerId``, or the legacy name for the batch rewritten as a pre-rename one, see
  ``LEGACY_FILE``), ``accountId`` / ``batchId`` (local ids), ``inserted`` / ``duplicates``,
  and ``parsed``: what a re-import parses, one object per row in FILE order: ``rowIndex``, ``rank``
  (``ordering.chronological_ranks``: the commit counts occurrences in this order), ``tradeDate``,
  ``type``, ``externalRef`` (raw), ``quantity`` / ``price`` / ``grossAmount`` / ``cashAmount`` (decimal
  text as parsed, before ``copy_abs``), ``currency``, ``symbol`` / ``isin`` / ``name`` (raw hints),
  ``brokerSymbol`` / ``isinKey`` (the resolver's ``_HintKey``), ``instrumentId`` (final local id, null
  for cash rows), ``instrumentKeyV2`` (gid.md 4.6 from the row, Python reference), ``v1Hash`` (the hash
  the commit computed for the row) and ``storedTxnId`` (the row it inserted, null for a duplicate).
- ``stored``: ``alembic_version`` and ``tables``: table -> rows (column -> value exactly as SQLite
  holds it: text, integer or null; ``ORDER BY`` the primary key) of ``profiles``, ``accounts``,
  ``inv_import_batches``, ``inv_transactions``, ``inv_instruments``, ``inv_instrument_aliases``.
- ``storedV1``: per stored ``inv_transactions`` row (by id) the v1 hash inputs rebuilt from the stored
  columns (``DedupInput.from_transaction``): ``txnId``, ``kind`` (ref / content / reconciliation),
  ``accountId``, ``brokerId`` (the batch broker, before the legacy rename), ``instrumentKey`` (local
  id or ""), ``occurrence`` (smallest k whose hash equals the stored one; null for reconciliation),
  ``message`` (the hashed text) and ``ikeyGenesis`` (gid.md 7.2 from the stored aliases, ``gid:@<id>``
  standing for the instrument's gid; Python reference for genesis).
- ``findings``: counts of stored rows whose columns do not reproduce the parsed row (per field), v1
  recovery results and v2 instrument key agreement between the two sides (R-G2 / R-G4).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from collections import Counter
from collections.abc import Iterable
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packages" / "store" / "src" / "genesis" / "testing" / "invHashParity.json"
FROZEN = "2026-03-01T10:00:00"
TABLES = (
    "profiles",
    "accounts",
    "inv_import_batches",
    "inv_transactions",
    "inv_instruments",
    "inv_instrument_aliases",
)
K_MAX = 1000

HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,note,source"
)


def _txn(date, kind, *, time="", ref="", symbol="", isin="", name="", exchange="", qty="",
         price="", ccy="PLN", gross="", fee="", tax="", cash="", cash_ccy="", fx="", note="",
         source="") -> str:
    cells = ["1", "txn", date, time, kind, ref, symbol, isin, name, exchange, qty, price, ccy,
             gross, fee, tax, cash, cash_ccy, fx, note, source]
    return ",".join(cells)


def _position(date, *, symbol="", isin="", name="", exchange="", qty="", ccy="PLN") -> str:
    cells = ["1", "position", date, "", "", "", symbol, isin, name, exchange, qty, "", ccy,
             "", "", "", "", "", "", "", ""]
    return ",".join(cells)


def _csv(lines: list[str]) -> bytes:
    return ("\n".join([HEADER, *lines]) + "\n").encode("utf-8")


ABC = {"symbol": "ABC", "isin": "PLABC0000016", "name": "ABC Example SA", "exchange": "XWAR"}
XYZ = {"symbol": "XYZ", "exchange": "XNAS"}  # symbol only
ISIN_ONLY = {"isin": "IE00BEXAMPL1"}  # neither symbol nor name
NAME_ONLY = {"name": "Fundusz Syntetyczny"}  # the name is the broker symbol
SRC = "examplebroker"

# File 1: partial fills sharing a ref, an identical fill, identical rows without refs, cash rows, the
# ISIN-only, symbol-only and name-only instruments, and a dividend row naming ABC by ISIN only.
FILE_1 = [
    _txn("2026-01-05", "deposit", ref="D-1", cash="20000.00", source=SRC),
    _txn("2026-01-07", "buy", time="09:15", ref="O-7", **ABC, qty="10", price="50.00",
         gross="500.00", fee="1.00", cash="-501.00"),
    _txn("2026-01-07", "buy", time="09:15", ref="O-7", **ABC, qty="5", price="50.00", gross="250.00",
         cash="-250.00"),
    _txn("2026-01-07", "buy", time="09:15", ref="O-7", **ABC, qty="5", price="50.0", gross="250.0",
         cash="-250.0"),
    _txn("2026-01-08", "buy", **XYZ, qty="3", price="20", ccy="USD", gross="60", cash="-240.00",
         cash_ccy="PLN", fx="4.0"),
    _txn("2026-01-08", "buy", **XYZ, qty="3", price="20", ccy="USD", gross="60", cash="-240.00",
         cash_ccy="PLN", fx="4.0"),
    _txn("2026-01-09", "buy", **ISIN_ONLY, qty="2", price="100", ccy="EUR", gross="200",
         cash="-860.00", cash_ccy="PLN", fx="4.3"),
    _txn("2026-01-10", "buy", **NAME_ONLY, qty="1.5", price="10", gross="15", cash="-15"),
    _txn("2026-01-12", "dividend", ref="DV-1", isin="PLABC0000016", gross="12.00", tax="1.80",
         cash="10.20"),
    _txn("2026-01-12", "fee", cash="-5.00", note="Opłata"),
    _txn("2026-01-12", "fee", cash="-5.00", note="Opłata"),
]

# File 2: a newest-first re-export overlapping file 1 plus new rows; two rows identical for dedup
# but with different notes on one day (newest first: their chronological order is the reverse of
# the file order); only one of file 1's two identical XYZ rows.
FILE_2 = [
    _txn("2026-01-20", "sell", ref="S-1", **ABC, qty="5", price="60", gross="300", fee="1",
         cash="299", source=SRC),
    _txn("2026-01-20", "buy", **XYZ, qty="1", price="21", ccy="USD", gross="21", cash="-84.00",
         cash_ccy="PLN", fx="4.0", note="pierwszy"),
    _txn("2026-01-20", "buy", **XYZ, qty="1", price="21", ccy="USD", gross="21", cash="-84.00",
         cash_ccy="PLN", fx="4.0", note="drugi"),
    FILE_1[10],
    FILE_1[9],
    FILE_1[8],
    FILE_1[7],
    FILE_1[6],
    FILE_1[4],
    FILE_1[3],
    FILE_1[2],
    FILE_1[1],
]

# File 3: no source (the canonical namespace "cashu", hashed as its legacy name), ABC matched by ISIN
# (learns the cashu alias), a position snapshot with one reconciliation correction applied.
FILE_3 = [
    _txn("2026-02-02", "deposit", ref="L-1", cash="5000"),
    _txn("2026-02-03", "buy", ref="L-2", **ABC, qty="10", price="50", gross="500", cash="-500"),
    _txn("2026-02-04", "buy", symbol="QQQ", name="Q Fund", exchange="XNAS", qty="2", price="100",
         gross="200", cash="-200"),
    _position("2026-02-27", **ABC, qty="12"),
    _position("2026-02-27", symbol="QQQ", name="Q Fund", exchange="XNAS", qty="2"),
]


# File 4: no source (namespace "cashu"), an instrument only this file names. After the commit its
# batch and that instrument's aliases are rewritten to the legacy namespace, as a database imported
# before the rename holds them (S26 review F2 class b: genesis names the instrument under the stored
# broker, a re-import under "cashu").
LEGACY_FILE = "synthetic_4.csv"
LEGACY_BROKER = "finanse"  # legacy name: the pre-rename canonical namespace a stored batch can hold
FILE_4 = [
    _txn("2026-02-10", "deposit", ref="F-0", cash="1000"),
    _txn("2026-02-11", "buy", ref="F-1", symbol="FNX", exchange="XWAR", qty="4", price="25",
         gross="100", cash="-100"),
    _txn("2026-02-12", "buy", symbol="FNX", exchange="XWAR", qty="2", price="26", gross="52",
         cash="-52"),
]

# File 5: a broker symbol change: one ISIN under an old and then a new symbol, so the instrument
# holds two aliases in one broker namespace (S26 review F2 class c: genesis takes the smallest alias
# id, a re-import the row's own symbol).
SRC_RENAME = "renamebroker"
FILE_5 = [
    _txn("2026-02-15", "buy", ref="R-1", symbol="OLDX", isin="PLOLDX000018", exchange="XWAR",
         qty="1", price="10", gross="10", cash="-10", source=SRC_RENAME),
    _txn("2026-02-20", "buy", ref="R-2", symbol="NEWX", isin="PLOLDX000018", exchange="XWAR",
         qty="1", price="11", gross="11", cash="-11", source=SRC_RENAME),
]


def _isolate(tmp: Path) -> None:
    """Point every path cashU resolves into ``tmp`` before anything imports it."""
    os.environ.update(
        {
            "TZ": "UTC",
            "CASHU_TESTING": "1",
            "HOME": str(tmp / "home"),
            "CASHU_DATA_DIR": str(tmp / "data"),
            "CASHU_LEGACY_DATA_DIR": str(tmp / "legacy"),
            "CASHU_WORKSPACES_DIR": str(tmp / "workspaces"),
            "CASHU_LAUNCH_AGENTS_DIR": str(tmp / "LaunchAgents"),
            "CASHU_APP_BUNDLE": "none",
            "CASHU_AUTO_DAILY": "0",
            "PYTHON_KEYRING_BACKEND": "keyring.backends.fail.Keyring",
        }
    )
    os.environ.pop("CASHU_DATABASE_URL", None)


def build(tmp: Path) -> dict:
    _isolate(tmp)
    sys.path.insert(0, str(ROOT / "parity" / "python"))
    sys.path.insert(0, str(ROOT / "tests" / "investments" / "importing"))
    import frozen
    from imp_support import pl_export_utf8_bom, pl_mapping_yaml
    from sqlmodel import select

    from cashu.core import db, paths, profiles
    from cashu.modules.investments.domain import TxnSource
    from cashu.modules.investments.importing import ImportFile, dedup
    from cashu.modules.investments.importing.ordering import chronological_ranks
    from cashu.modules.investments.importing.resolver import InstrumentHint, _HintKey
    from cashu.modules.investments.models import InvTransaction
    from cashu.modules.investments.service import accounts, imports
    from cashu.modules.investments.store import convert

    data_dir = (tmp / "data").resolve()
    if paths.data_dir().resolve() != data_dir:
        raise SystemExit(f"refusing to run: data dir is not the temp dir ({paths.data_dir()})")
    db_file = data_dir / "cashu.db"
    db.engine = db.make_engine(f"sqlite:///{db_file}")
    _import_all()  # every module binds its date classes before the clock freezes (frozen.py)
    frozen.install(FROZEN)
    db.init_db()

    # Brokerage accounts get a random external id (uuid4); fixed ones keep the fixture stable.
    fixed_ids = iter(uuid.UUID(int=n) for n in range(1, 10))
    real_uuid4, uuid.uuid4 = uuid.uuid4, lambda: next(fixed_ids)
    try:
        with db.get_session() as s:
            profile = profiles.create_profile(
                s, name="Inwestor Syntetyczny", modules_=["investments"]
            )
            pid = profile.id
            a1 = accounts.add_account(s, pid, name="Konto Testowe 1", broker="dif").id
            a2 = accounts.add_account(s, pid, name="Konto Testowe 2", broker="dif").id
            a3 = accounts.add_account(s, pid, name="Konto Testowe 3", broker="dif").id
    finally:
        uuid.uuid4 = real_uuid4

    plan = [
        (a1, "synthetic_1.csv", _csv(FILE_1), {}, dt.datetime(2026, 3, 1, 11, tzinfo=dt.UTC)),
        (a1, "synthetic_2.csv", _csv(FILE_2), {}, dt.datetime(2026, 3, 1, 12, tzinfo=dt.UTC)),
        (a2, "synthetic_3.csv", _csv(FILE_3), {}, dt.datetime(2026, 3, 1, 13, tzinfo=dt.UTC)),
        (a2, "pl_broker.csv", pl_export_utf8_bom(),
         {"importer": "generic_csv", "mapping_yaml": pl_mapping_yaml()},
         dt.datetime(2026, 3, 1, 14, tzinfo=dt.UTC)),
        (a3, "synthetic_4.csv", _csv(FILE_4), {}, dt.datetime(2026, 3, 1, 15, tzinfo=dt.UTC)),
        (a3, "synthetic_5.csv", _csv(FILE_5), {}, dt.datetime(2026, 3, 1, 16, tzinfo=dt.UTC)),
    ]
    out_imports = []
    for account_id, name, content, extra, now in plan:
        with db.get_session() as s:
            prof = s.get(profiles.Profile, pid)
            request = imports.ImportRequest(ImportFile(name, content), account_id, **extra)
            preview = imports.preview(s, prof, request, now=now)
        if not preview.can_commit:
            raise SystemExit(f"{name}: cannot commit: {[str(e) for e in preview.errors]}")
        corrections = []
        if preview.reconciliation is not None:
            corrections = [c.txn.instrument_id for c in preview.reconciliation.corrections]
        recorded: list[tuple[str, ...]] = []
        real = imports.dedup_hashes

        def recording(*args, _real=real, _recorded=recorded, **kwargs):
            result = _real(*args, **kwargs)
            _recorded.append(result)
            return result

        imports.dedup_hashes = recording
        try:
            result = imports.commit(preview, corrections=corrections, now=now)
        finally:
            imports.dedup_hashes = real
        assert len(recorded) == 1
        parsed = preview.parse
        broker_id = preview.plan.broker_id  # contract.effective_broker_id of the import
        ranks = chronological_ranks(parsed.txns)
        with db.get_session() as s:
            stored_by_rank = {}
            for row in s.exec(
                select(InvTransaction).where(InvTransaction.import_batch_id == result.batch_id)
            ).all():
                if row.source != TxnSource.IMPORT.value:
                    continue
                offset = convert.aware(row.created_at) - now
                stored_by_rank[offset // dt.timedelta(milliseconds=1)] = row.id
        rows = []
        for i, txn in enumerate(parsed.txns):
            planned_id = preview.plan.rows[i].txn.instrument_id
            instrument_id = None
            if planned_id is not None:
                instrument_id = result.instrument_map.get(planned_id) or int(planned_id)
            key = _HintKey.of(InstrumentHint.from_txn(txn))
            if key.broker_symbol is not None:
                ikey = f"{broker_id}:{key.broker_symbol}"
            else:
                ikey = "" if key.isin is None else f"isin:{key.isin}"
            rows.append(
                {
                    "rowIndex": txn.row_index,
                    "rank": ranks[i],
                    "tradeDate": txn.trade_date.isoformat(),
                    "type": txn.type.value,
                    "externalRef": txn.external_ref,
                    "quantity": _dec(txn.quantity),
                    "price": _dec(txn.price),
                    "currency": str(txn.currency),
                    "grossAmount": _dec(txn.gross_amount),
                    "cashAmount": _dec(txn.cash_amount),
                    "symbol": txn.symbol,
                    "isin": txn.isin,
                    "name": txn.name,
                    "brokerSymbol": key.broker_symbol,
                    "isinKey": key.isin,
                    "instrumentId": instrument_id,
                    "instrumentKeyV2": ikey,
                    "v1Hash": recorded[0][ranks[i]],
                    "storedTxnId": stored_by_rank.get(ranks[i]),
                }
            )
        out_imports.append(
            {
                "name": name,
                "importer": preview.importer_id,
                "brokerId": broker_id,
                "storedBroker": broker_id,
                "accountId": account_id,
                "batchId": result.batch_id,
                "inserted": result.inserted,
                "duplicates": result.duplicates,
                "parsed": rows,
            }
        )
    db.engine.dispose()
    _rewrite_legacy(db_file, next(e for e in out_imports if e["name"] == LEGACY_FILE))

    stored, version = _dump(db_file)
    stored_v1 = _stored_v1(stored, dedup, Decimal)
    return {
        "meta": {
            "generator": "parity/python/inv_hash_parity.py",
            "alembic_version": version,
            "frozen_clock": FROZEN + "Z",
        },
        "imports": out_imports,
        "stored": {"alembic_version": version, "tables": stored},
        "storedV1": stored_v1,
        "findings": _findings(out_imports, stored, stored_v1),
    }


def _import_all() -> None:
    """Import every cashu module (as ``golden.import_all``), skipping GUI / migration entry points."""
    import importlib
    import pkgutil

    import cashu

    for info in pkgutil.walk_packages(cashu.__path__, "cashu."):
        if info.name.startswith(("cashu.desktop", "cashu.core.migrations", "cashu.__main__")):
            continue
        try:
            importlib.import_module(info.name)
        except Exception:  # noqa: BLE001, S112 - optional modules (GUI, platform specific)
            continue


def _dec(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _rewrite_legacy(db_file: Path, entry: dict) -> None:
    """Turn one committed batch into a pre-rename one: its ``broker`` and the canonical-namespace
    aliases of the instruments only it references take the legacy name (stored hashes already use
    it, ``dedup.dedup_hash``)."""
    if entry["brokerId"] != "cashu":
        raise SystemExit("the legacy file must import under the canonical namespace")
    con = sqlite3.connect(db_file)
    try:
        with con:
            batch = entry["batchId"]
            con.execute(
                "UPDATE inv_import_batches SET broker = ? WHERE id = ?", (LEGACY_BROKER, batch)
            )
            con.execute(
                "UPDATE inv_instrument_aliases SET namespace = ? WHERE namespace = 'cashu' AND "
                "instrument_id IN (SELECT instrument_id FROM inv_transactions WHERE "
                "import_batch_id = ?) AND instrument_id NOT IN (SELECT instrument_id FROM "
                "inv_transactions WHERE import_batch_id != ? AND instrument_id IS NOT NULL)",
                (LEGACY_BROKER, batch, batch),
            )
    finally:
        con.close()
    entry["storedBroker"] = LEGACY_BROKER


def _dump(db_file: Path) -> tuple[dict, str]:
    con = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        tables = {}
        for table in TABLES:
            cur = con.execute(f"SELECT * FROM {table} ORDER BY id")
            columns = [c[0] for c in cur.description]
            tables[table] = [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]
        return tables, version
    finally:
        con.close()


def _stored_v1(stored: dict, dedup, D) -> list[dict]:
    """v1 inputs of every stored transaction rebuilt from its columns, with the recovered occurrence."""
    from cashu.modules.investments.domain import TxnType

    batches = {b["id"]: b for b in stored["inv_import_batches"]}
    instruments = {i["id"]: i for i in stored["inv_instruments"]}
    aliases: dict[int, list[dict]] = {}
    for alias in stored["inv_instrument_aliases"]:
        aliases.setdefault(alias["instrument_id"], []).append(alias)
    out = []
    for row in stored["inv_transactions"]:
        batch = batches.get(row["import_batch_id"])
        broker = None if batch is None else batch["broker"]
        instrument_key = "" if row["instrument_id"] is None else str(row["instrument_id"])
        account = str(row["account_id"])
        entry = {"txnId": row["id"], "accountId": account, "brokerId": broker,
                 "instrumentKey": instrument_key}
        if row["source"] == "reconciliation":
            parts = ["v1", "reconciliation", account, instrument_key, row["trade_date"], row["type"],
                     dedup.decimal_key(D(row["quantity"]))]
            entry |= {"kind": "reconciliation", "occurrence": None,
                      "ikeyGenesis": f"gid:@{row['instrument_id']}"}
            message = "\x1f".join(parts)
            entry["message"] = message
            entry["matches"] = _sha(message) == row["dedup_hash"]
            out.append(entry)
            continue
        inp = dedup.DedupInput(
            trade_date=dt.date.fromisoformat(row["trade_date"]),
            type=TxnType(row["type"]),
            gross_amount=D(row["gross_amount"]),
            cash_amount=D(row["cash_amount"]),
            external_ref=row["external_ref"],
            instrument_key=instrument_key or None,
            quantity=None if row["quantity"] is None else D(row["quantity"]),
            price=None if row["price"] is None else D(row["price"]),
            currency=row["currency"],
        )
        hash_broker = broker if broker is not None else "manual"
        occurrence = next(
            (k for k in range(K_MAX)
             if dedup.dedup_hash(inp, account_id=account, broker_id=hash_broker, occurrence=k)
             == row["dedup_hash"]),
            None,
        )
        kind = "content" if inp.ref is None else "ref"
        if inp.ref is None:
            parts = ["v1", "content", account, inp.content_key]
        else:
            renamed = "finanse" if hash_broker == "cashu" else hash_broker
            parts = ["v1", "ref", account, renamed, inp.ref, inp.fill_key]
        parts.append("" if occurrence is None else str(occurrence))
        entry |= {"kind": kind, "occurrence": occurrence, "message": "\x1f".join(parts),
                  "matches": occurrence is not None,
                  "ikeyGenesis": _ikey_genesis(row, broker, instruments, aliases)}
        out.append(entry)
    return out


def _ikey_genesis(row: dict, broker: str | None, instruments: dict, aliases: dict) -> str:
    """gid.md 7.2 from the stored rows."""
    instrument_id = row["instrument_id"]
    if instrument_id is None:
        return ""
    own = sorted(aliases.get(instrument_id, []), key=lambda a: a["id"])
    if broker is not None:
        for alias in own:
            if alias["namespace"] == broker:
                return f"{broker}:{alias['value']}"
    for alias in own:
        if alias["namespace"] == "isin":
            return f"isin:{alias['value']}"
    isin = instruments[instrument_id]["isin"]
    return f"isin:{isin}" if isin else f"gid:@{instrument_id}"


def _sha(message: str) -> str:
    import hashlib

    return hashlib.sha256(message.encode("utf-8")).hexdigest()


def _findings(out_imports: list[dict], stored: dict, stored_v1: list[dict]) -> dict:
    """Counts of the R-G2 / R-G4 checks: stored columns vs the parsed row they came from, v1
    recovery, and the v2 instrument key of both sides."""
    txns = {t["id"]: t for t in stored["inv_transactions"]}
    v1 = {e["txnId"]: e for e in stored_v1}
    fields = Counter()
    ikey = Counter()
    checked = 0
    for entry in out_imports:
        for p in entry["parsed"]:
            txn_id = p["storedTxnId"]
            if txn_id is None:
                continue
            checked += 1
            t = txns[txn_id]
            pairs = {
                "trade_date": (t["trade_date"], p["tradeDate"]),
                "type": (t["type"], p["type"]),
                "external_ref": (t["external_ref"], p["externalRef"]),
                "currency": (t["currency"], p["currency"]),
                "instrument_id": (t["instrument_id"], p["instrumentId"]),
            }
            for name, (s, q) in pairs.items():
                if s != q:
                    fields[name] += 1
            for name, (s, q) in {
                "quantity": (t["quantity"], p["quantity"]),
                "gross_amount": (t["gross_amount"], p["grossAmount"]),
            }.items():
                if (s is None) != (q is None) or (s is not None and Decimal(s) != abs(Decimal(q))):
                    fields[name] += 1
            for name, (s, q) in {
                "price": (t["price"], p["price"]),
                "cash_amount": (t["cash_amount"], p["cashAmount"]),
            }.items():
                if (s is None) != (q is None) or (s is not None and Decimal(s) != Decimal(q)):
                    fields[name] += 1
            if t["dedup_hash"] != p["v1Hash"]:
                fields["dedup_hash"] += 1
            genesis = v1[txn_id]["ikeyGenesis"]
            ikey["equal" if genesis == p["instrumentKeyV2"] else "differ"] += 1
    recovered = Counter(
        ("recon_match" if e["matches"] else "recon_mismatch")
        if e["kind"] == "reconciliation"
        else ("occ_v1_match" if e["matches"] else "occ_no_match")
        for e in stored_v1
    )
    return {
        "storedImportRowsChecked": checked,
        "columnMismatches": dict(sorted(fields.items())),
        "v1Recovery": dict(sorted(recovered.items())),
        "ikeyV2GenesisVsParsed": dict(sorted(ikey.items())),
    }


def render() -> bytes:
    with tempfile.TemporaryDirectory(prefix="cashu-inv-hash-parity-") as tmp:
        result = build(Path(tmp))
    raw = json.dumps(result, ensure_ascii=False, indent=1) + "\n"
    return _biome_format(raw).encode("utf-8")


def _biome_format(text: str) -> str:
    """The repo's Biome formatting of the fixture, so the committed file passes `pnpm lint` and
    `--check` compares exactly what is committed."""
    import subprocess

    biome = ROOT / "node_modules" / ".bin" / "biome"
    done = subprocess.run(
        [str(biome), "format", f"--stdin-file-path={OUT.relative_to(ROOT)}"],
        input=text,
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=True,
    )
    return done.stdout


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    content = render()
    findings = json.loads(content)["findings"]
    print(json.dumps(findings))
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
