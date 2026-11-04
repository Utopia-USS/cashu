#!/usr/bin/env python3
"""Re-import identity vectors for the TypeScript investments importing port (scope S17d).

    .venv/bin/python parity/python/vectors_inv_reimport.py            # writes the vectors
    .venv/bin/python parity/python/vectors_inv_reimport.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/inv-reimport.jsonl``: synthetic broker files committed through the
REAL Python import service into a temp data dir (refused otherwise; frozen clock), then every file
previewed again (a re-import). The three classes of the S26 review F2 are covered on purpose:

- ``isin_only``: rows a broker exported with an ISIN only, of an instrument that holds an alias in that
  broker's namespace (within one file, across files, and an instrument that learned its broker alias
  from a later file);
- ``legacy``: a batch stored under the pre-rename broker name ``finanse`` (legacy name) with its aliases
  in the ``finanse`` namespace (as a database from before the rename holds them; the rewrite keeps every
  stored hash valid, ``dedup_hash`` hashes ``cashu`` as ``finanse``), re-imported and extended by a
  post-rename ``cashu`` file that adds a second alias to one instrument;
- ``two_aliases``: an instrument that learned a second alias in one broker namespace (a ticker change
  matched by ISIN).

Python truth recorded per re-imported row: the resolved instrument (its stored id), the v1 hash and
whether it is a duplicate. Per stored row: the occurrence recovered from its v1 hash and the gid.md 7.2
instrument key (``ikey``: Python reference of ``importing/instrumentKey.ts``, ``gid:@<id>`` standing for
the instrument gid), plus the two keys that disagreed before S17d (``hintKey``: gid.md 4.6 from the
row's hints; ``oldGenesisKey``: 7.2 with the batch broker as stored and the smallest alias id).

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then ``[kind, object]`` lines:
``["stored", {...}]`` once (tables after every commit, ``ORDER BY id``; ``instruments`` = the domain
instruments as ``store.instruments.load`` returns them), then ``["import", {...}]`` per file in commit
order with its re-import.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
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
OUT = ROOT / "packages" / "domain" / "test" / "vectors" / "inv-reimport.jsonl"
FROZEN = "2026-03-01T10:00:00"
K_MAX = 1000
LEGACY = "finanse"  # legacy name: the pre-rename canonical broker id / alias namespace

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


def _csv(lines: list[str]) -> bytes:
    return ("\n".join([HEADER, *lines]) + "\n").encode("utf-8")


ABC_ISIN = "PLABC0000016"
FUND_ISIN = "IE00BEXAMPL1"
OLD_ISIN = "PLOLD0000011"
AAA_ISIN = "PLAAA0000019"
EXB = "examplebroker"
OTB = "otherbroker"

# isin_only, file 1: ABC by symbol + ISIN (learns examplebroker:ABC), then a dividend naming ABC by
# ISIN only; a fund bought by ISIN only (no broker alias yet); two identical fee rows.
ISIN_ONLY_1 = [
    _txn("2026-01-05", "deposit", ref="D-1", cash="10000.00", source=EXB),
    _txn("2026-01-07", "buy", ref="O-1", symbol="ABC", isin=ABC_ISIN, name="ABC Example SA",
         exchange="XWAR", qty="10", price="50.00", gross="500.00", fee="1.00", cash="-501.00"),
    _txn("2026-01-09", "buy", isin=FUND_ISIN, qty="2", price="100", ccy="EUR", gross="200",
         cash="-860.00", cash_ccy="PLN", fx="4.3"),
    _txn("2026-01-12", "dividend", ref="DV-1", isin=ABC_ISIN, gross="12.00", tax="1.80",
         cash="10.20"),
    _txn("2026-01-12", "fee", cash="-5.00", note="Opłata"),
    _txn("2026-01-12", "fee", cash="-5.00", note="Opłata"),
]
# isin_only, file 2: ABC by ISIN only twice (identical rows, no ref), and the fund now with its broker
# symbol (it learns examplebroker:EXF, so file 1's ISIN-only fund row resolves to a broker-aliased
# instrument too).
ISIN_ONLY_2 = [
    _txn("2026-01-20", "buy", isin=ABC_ISIN, qty="2", price="55", gross="110", cash="-110",
         source=EXB),
    _txn("2026-01-20", "buy", isin=ABC_ISIN, qty="2", price="55", gross="110", cash="-110"),
    _txn("2026-01-21", "buy", ref="O-9", symbol="EXF", isin=FUND_ISIN, qty="1", price="101",
         ccy="EUR", gross="101", cash="-434.30", cash_ccy="PLN", fx="4.3"),
]
# legacy, file 1 (rewritten to the pre-rename names after its commit): no source (canonical namespace).
LEGACY_1 = [
    _txn("2026-02-02", "deposit", ref="L-1", cash="5000"),
    _txn("2026-02-03", "buy", ref="L-2", symbol="OLD", isin=OLD_ISIN, name="Old Name SA",
         exchange="XWAR", qty="10", price="50", gross="500", cash="-500"),
    _txn("2026-02-04", "buy", symbol="QQQ", name="Q Fund", exchange="XNAS", qty="2", price="100",
         gross="200", cash="-200"),
]
# legacy, file 2 (after the rename, namespace cashu): the same company under a new ticker (matched by
# ISIN, learns cashu:NEW next to finanse:OLD, legacy name), its old ticker (matched through the
# legacy alias) and Q.
LEGACY_2 = [
    _txn("2026-02-10", "buy", ref="L-3", symbol="NEW", isin=OLD_ISIN, exchange="XWAR", qty="1",
         price="60", gross="60", cash="-60"),
    _txn("2026-02-11", "sell", ref="L-4", symbol="OLD", qty="1", price="61", gross="61", cash="61"),
    _txn("2026-02-12", "buy", symbol="QQQ", name="Q Fund", exchange="XNAS", qty="1", price="101",
         gross="101", cash="-101"),
]
# two_aliases, file 1: AAA by symbol + ISIN (learns otherbroker:AAA).
TWO_1 = [
    _txn("2026-02-15", "buy", ref="X-1", symbol="AAA", isin=AAA_ISIN, exchange="XWAR", qty="4",
         price="25", gross="100", cash="-100", source=OTB),
    _txn("2026-02-16", "sell", ref="X-2", symbol="AAA", isin=AAA_ISIN, qty="1", price="26",
         gross="26", cash="26"),
]
# two_aliases, file 2: the ticker changed to BBB (matched by ISIN, learns otherbroker:BBB), and a
# dividend naming BBB by symbol only (matched through the new alias).
TWO_2 = [
    _txn("2026-02-20", "buy", ref="X-3", symbol="BBB", isin=AAA_ISIN, qty="2", price="27",
         gross="54", cash="-54", source=OTB),
    _txn("2026-02-21", "dividend", symbol="BBB", gross="3", cash="3"),
]

FILES = [
    # (scenario, account key, file name, rows, legacy rewrite after commit)
    ("isin_only", "a1", "isin_only_1.csv", ISIN_ONLY_1, False),
    ("isin_only", "a1", "isin_only_2.csv", ISIN_ONLY_2, False),
    ("legacy", "a2", "legacy_1.csv", LEGACY_1, True),
    ("legacy", "a2", "legacy_2.csv", LEGACY_2, False),
    ("two_aliases", "a3", "two_1.csv", TWO_1, False),
    ("two_aliases", "a3", "two_2.csv", TWO_2, False),
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
    os.environ.pop("CASHU_SYNC", None)


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


def build(tmp: Path) -> list:
    _isolate(tmp)
    sys.path.insert(0, str(ROOT / "parity" / "python"))
    sys.path.insert(0, str(ROOT / "parity" / "python" / "oracle" / "src"))
    import frozen
    from sqlmodel import select

    from cashu.core import db, paths, profiles
    from cashu.modules.investments.importing import ImportFile
    from cashu.modules.investments.importing.ordering import chronological_ranks
    from cashu.modules.investments.importing.resolver import InstrumentHint, _HintKey
    from cashu.modules.investments.models import InvImportBatch, InvInstrumentAlias
    from cashu.modules.investments.service import accounts, imports
    from cashu.modules.investments.store import instruments as inst_store

    data_dir = (tmp / "data").resolve()
    if paths.data_dir().resolve() != data_dir:
        raise SystemExit(f"refusing to run: data dir is not the temp dir ({paths.data_dir()})")
    db_file = data_dir / "cashu.db"
    db.engine = db.make_engine(f"sqlite:///{db_file}")
    _import_all()  # every module binds its date classes before the clock freezes (frozen.py)
    frozen.install(FROZEN)
    db.init_db()

    fixed_ids = iter(uuid.UUID(int=n) for n in range(1, 10))
    real_uuid4, uuid.uuid4 = uuid.uuid4, lambda: next(fixed_ids)
    try:
        with db.get_session() as s:
            profile = profiles.create_profile(
                s, name="Inwestor Syntetyczny", modules_=["investments"]
            )
            pid = profile.id
            account_ids = {
                key: accounts.add_account(s, pid, name=f"Konto Testowe {n}", broker="dif").id
                for n, key in enumerate(("a1", "a2", "a3"), start=1)
            }
    finally:
        uuid.uuid4 = real_uuid4

    commits = []
    for n, (scenario, account_key, name, rows, legacy) in enumerate(FILES):
        now = dt.datetime(2026, 3, 1, 11, n, tzinfo=dt.UTC)
        content = _csv(rows)
        with db.get_session() as s:
            prof = s.get(profiles.Profile, pid)
            request = imports.ImportRequest(ImportFile(name, content), account_ids[account_key])
            preview = imports.preview(s, prof, request, now=now)
        if not preview.can_commit:
            raise SystemExit(f"{name}: cannot commit: {[str(e) for e in preview.errors]}")
        result = imports.commit(preview, now=now)
        if legacy:
            _rewrite_legacy(db, result.batch_id, InvImportBatch, InvInstrumentAlias, select)
        commits.append(
            {
                "scenario": scenario,
                "name": name,
                "accountId": account_ids[account_key],
                "batchId": result.batch_id,
                "inserted": result.inserted,
                "duplicates": result.duplicates,
                "content": content.decode("utf-8"),
            }
        )

    stored = _dump(db_file)
    with db.get_session() as s:
        ids = [row["id"] for row in stored["inv_instruments"]]
        loaded = inst_store.load(s, ids)
        stored["instruments"] = [_instrument(loaded[i]) for i in ids]

    by_hash = {(t["account_id"], t["dedup_hash"]): t["id"] for t in stored["inv_transactions"]}
    lines: list = []
    imports_out: list[dict] = []
    for n, entry in enumerate(commits):
        now = dt.datetime(2026, 3, 2, 9, n, tzinfo=dt.UTC)
        with db.get_session() as s:
            prof = s.get(profiles.Profile, pid)
            request = imports.ImportRequest(
                ImportFile(entry["name"], entry["content"].encode("utf-8")), entry["accountId"]
            )
            preview = imports.preview(s, prof, request, now=now)
        parsed = preview.parse
        broker_id = preview.plan.broker_id
        ranks = chronological_ranks(parsed.txns)
        rows = []
        for i, txn in enumerate(parsed.txns):
            planned = preview.plan.rows[i]
            key = _HintKey.of(InstrumentHint.from_txn(txn))
            if key.broker_symbol is not None:
                hint_key = f"{broker_id}:{key.broker_symbol}"
            else:
                hint_key = "" if key.isin is None else f"isin:{key.isin}"
            instrument_id = planned.txn.instrument_id
            rows.append(
                {
                    "rowIndex": txn.row_index,
                    "rank": ranks[i],
                    "instrumentId": None if instrument_id is None else int(instrument_id),
                    "v1Hash": planned.txn.dedup_hash,
                    "isDuplicate": planned.is_duplicate,
                    "hintKey": hint_key,
                    "storedTxnId": by_hash.get((entry["accountId"], planned.txn.dedup_hash)),
                }
            )
        imports_out.append(
            {**entry, "reimport": {"brokerId": broker_id, "importer": preview.importer_id,
                                   "rows": rows}}
        )
    db.engine.dispose()

    from cashu.modules.investments.importing import dedup

    stored["txnKeys"] = _txn_keys(stored, dedup)
    findings = _findings(imports_out, stored)
    lines.append(["stored", stored])
    for entry in imports_out:
        lines.append(["import", entry])
    meta = {
        "name": OUT.stem,
        "count": len(lines),
        "layout": "[kind, object]: stored once, then import per file in commit order",
        "generator": "parity/python/vectors_inv_reimport.py",
        "frozen_clock": FROZEN + "Z",
        "findings": findings,
    }
    return [{"meta": meta}, *lines]


def _rewrite_legacy(db, batch_id: int, InvImportBatch, InvInstrumentAlias, select) -> None:
    """The batch and the canonical aliases as a database from before the rename holds them."""
    with db.get_session() as s:
        batch = s.get(InvImportBatch, batch_id)
        batch.broker = LEGACY
        batch.importer = LEGACY
        s.add(batch)
        for alias in s.exec(
            select(InvInstrumentAlias).where(InvInstrumentAlias.namespace == "cashu")
        ).all():
            alias.namespace = LEGACY
            s.add(alias)
        s.commit()


def _instrument(i) -> dict:
    return {
        "id": i.id,
        "name": i.name,
        "currency": str(i.currency),
        "assetClass": i.asset_class.value,
        "symbol": i.symbol,
        "isin": i.isin,
        "mic": i.mic,
        "needsClassification": i.needs_classification,
        "valuationMode": None if i.valuation_mode is None else i.valuation_mode.value,
        "status": i.status.value,
        "aliases": [[a.namespace, a.value, a.guessed] for a in i.aliases],
    }


def _dump(db_file: Path) -> dict:
    con = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        def rows(sql: str) -> list[dict]:
            cur = con.execute(sql)
            columns = [c[0] for c in cur.description]
            return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]

        return {
            "inv_import_batches": rows(
                "SELECT id, account_id, importer, broker FROM inv_import_batches ORDER BY id"
            ),
            "inv_instruments": rows("SELECT id, isin FROM inv_instruments ORDER BY id"),
            "inv_instrument_aliases": rows(
                "SELECT id, instrument_id, namespace, value, guessed FROM inv_instrument_aliases "
                "ORDER BY id"
            ),
            "inv_transactions": rows(
                "SELECT id, account_id, import_batch_id, instrument_id, source, type, trade_date, "
                "currency, gross_amount, cash_amount, quantity, price, external_ref, dedup_hash, "
                "created_at FROM inv_transactions ORDER BY id"
            ),
        }
    finally:
        con.close()


def _canonical(namespace: str) -> str:
    return "cashu" if namespace == LEGACY else namespace


def _equivalent(namespace: str) -> tuple[str, ...]:
    return ("cashu", LEGACY) if namespace in ("cashu", LEGACY) else (namespace,)


def _ikey(instrument_id: int | None, broker: str | None, isin_column: str | None,
          aliases: list[dict]) -> str:
    """gid.md 7.2 (S17d): broker alias in an equivalent namespace (legacy namespace first, confirmed
    first, smallest id) under the canonical namespace, else the isin alias, the ISIN column, the gid."""
    if instrument_id is None:
        return ""

    def first(namespaces: tuple[str, ...]) -> dict | None:
        own = [a for a in aliases if a["namespace"] in namespaces]
        own.sort(key=lambda a: (a["namespace"] != LEGACY, bool(a["guessed"]), a["id"]))
        return own[0] if own else None

    if broker is not None:
        alias = first(_equivalent(broker))
        if alias is not None:
            return f"{_canonical(broker)}:{alias['value']}"
    alias = first(("isin",))
    if alias is not None:
        return f"isin:{alias['value']}"
    return f"isin:{isin_column}" if isin_column else f"gid:@{instrument_id}"


def _old_genesis_key(instrument_id: int | None, broker: str | None, isin_column: str | None,
                     aliases: list[dict]) -> str:
    """7.2 before S17d (ts-genesis invHashes.ts): the batch broker as stored, smallest alias id."""
    if instrument_id is None:
        return ""
    own = sorted(aliases, key=lambda a: a["id"])
    if broker is not None:
        for alias in own:
            if alias["namespace"] in _equivalent(broker):
                return f"{broker}:{alias['value']}"
    for alias in own:
        if alias["namespace"] == "isin":
            return f"isin:{alias['value']}"
    return f"isin:{isin_column}" if isin_column else f"gid:@{instrument_id}"


def _txn_keys(stored: dict, dedup) -> list[dict]:
    """Per stored row: the v1 occurrence (smallest k reproducing the stored hash), the 7.2 key and the
    pre-S17d genesis key."""
    from cashu.modules.investments.domain import TxnType

    batches = {b["id"]: b for b in stored["inv_import_batches"]}
    isin = {i["id"]: i["isin"] for i in stored["inv_instruments"]}
    aliases: dict[int, list[dict]] = {}
    for alias in stored["inv_instrument_aliases"]:
        aliases.setdefault(alias["instrument_id"], []).append(alias)
    out = []
    for row in stored["inv_transactions"]:
        if row["source"] != "import":
            continue
        batch = batches[row["import_batch_id"]]
        iid = row["instrument_id"]
        inp = dedup.DedupInput(
            trade_date=dt.date.fromisoformat(row["trade_date"]),
            type=TxnType(row["type"]),
            gross_amount=Decimal(row["gross_amount"]),
            cash_amount=Decimal(row["cash_amount"]),
            external_ref=row["external_ref"],
            instrument_key=None if iid is None else str(iid),
            quantity=None if row["quantity"] is None else Decimal(row["quantity"]),
            price=None if row["price"] is None else Decimal(row["price"]),
            currency=row["currency"],
        )
        account = str(row["account_id"])
        occurrence = next(
            (k for k in range(K_MAX)
             if dedup.dedup_hash(inp, account_id=account, broker_id=batch["broker"], occurrence=k)
             == row["dedup_hash"]),
            None,
        )
        own = aliases.get(iid, []) if iid is not None else []
        out.append(
            {
                "txnId": row["id"],
                "occurrence": occurrence,
                "ikey": _ikey(iid, batch["broker"], isin.get(iid), own),
                "oldGenesisKey": _old_genesis_key(iid, batch["broker"], isin.get(iid), own),
            }
        )
    return out


def _findings(imports_out: list[dict], stored: dict) -> dict:
    """Per scenario: re-imported rows, duplicates (Python), and the rows where the pre-S17d genesis key
    differs from the gid.md 4.6 hint key (the classes that duplicated rows), and from the 7.2 key."""
    keys = {k["txnId"]: k for k in stored["txnKeys"]}
    out: dict[str, Counter] = {}
    for entry in imports_out:
        c = out.setdefault(entry["scenario"], Counter())
        for row in entry["reimport"]["rows"]:
            c["rows"] += 1
            c["python_duplicates"] += row["isDuplicate"]
            k = keys.get(row["storedTxnId"])
            if k is None:
                c["no_stored_row"] += 1
                continue
            c["v1_recovered"] += k["occurrence"] is not None
            c["old_genesis_vs_hint_differ"] += k["oldGenesisKey"] != row["hintKey"]
            c["old_genesis_vs_ikey_differ"] += k["oldGenesisKey"] != k["ikey"]
    return {name: dict(sorted(c.items())) for name, c in sorted(out.items())}


def render() -> bytes:
    with tempfile.TemporaryDirectory(prefix="cashu-inv-reimport-") as tmp:
        lines = build(Path(tmp))
    text = "".join(json.dumps(line, ensure_ascii=True, separators=(",", ":")) + "\n" for line in lines)
    return text.encode("ascii")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    content = render()
    print(json.dumps(json.loads(content.split(b"\n", 1)[0])["meta"]["findings"]))
    if args.check:
        if not OUT.exists() or OUT.read_bytes() != content:
            print(f"stale: {OUT.relative_to(ROOT)}")
            return 1
        print(f"up to date ({_sha(content)})")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(content)
    print(f"{OUT.relative_to(ROOT)} written ({_sha(content)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
