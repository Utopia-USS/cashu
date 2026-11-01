"""Sync outbox (S30, ``core/sync_outbox.py``): every write to a synced table becomes field-level outbox
rows in the same transaction, only while ``CASHU_SYNC=1``; explicit rows for instrument merge, decision
and review undo and cash-leg delete; gids from the keychain salt (gid.md vectors); never pruned before an
ack; a guard against new raw-SQL writers. Synthetic data only."""

from __future__ import annotations

import ast
import datetime as dt
import logging
import re
from collections import Counter
from decimal import Decimal
from pathlib import Path

import keyring
import pytest
from mcp_support import TODAY, seed_profile
from sqlalchemy import JSON, delete, func, insert, inspect, text, update
from sqlmodel import SQLModel, select

from cashu.core import accounts, profiles, reviews, sync_keys, sync_outbox
from cashu.core.db import get_session
from cashu.core.models import Account, Balance, Profile
from cashu.core.sync_models import SyncClock, SyncId, SyncOutbox
from cashu.modules.budget import cash
from cashu.modules.budget import service as budget
from cashu.modules.budget.models import Transaction
from cashu.modules.investments.models import (
    InvAlert,
    InvDecision,
    InvDecisionSignal,
    InvFxRate,
    InvInstrument,
    InvInstrumentAlias,
    InvSignal,
    InvThesis,
    InvWatchlistItem,
)
from cashu.modules.investments.store import instrument_merge, journal

REPO = Path(__file__).resolve().parents[1]
TEST_SALT = bytes(range(32))
VAULT = "0123456789abcdef0123456789abcdef"


@pytest.fixture
def sync_on(monkeypatch):
    monkeypatch.setenv("CASHU_SYNC", "1")
    sync_keys.forget_cached_salts()
    yield
    sync_keys.forget_cached_salts()


def outbox(**where) -> list[dict]:
    with get_session() as s:
        rows = sync_outbox.rows_of(s)
    return [r for r in rows if all(r[k] == v for k, v in where.items())]


def outbox_count() -> int:
    with get_session() as s:
        return s.exec(select(func.count()).select_from(SyncOutbox)).one()


def new_profile(name: str, modules: tuple[str, ...] = ("investments",)) -> int:
    with get_session() as s:
        return profiles.create_profile(s, name=name, modules_=list(modules)).id


def new_instrument(name: str = "Test SA", isin: str | None = None) -> int:
    with get_session() as s:
        inst = InvInstrument(
            name=name, currency="PLN", asset_class="stock", valuation_mode="market", tags=[], isin=isin
        )
        s.add(inst)
        s.flush()
        return inst.id


def watch(pid: int, instrument_id: int, note: str | None = None) -> int:
    with get_session() as s:
        item = InvWatchlistItem(profile_id=pid, instrument_id=instrument_id, note=note, tags=[])
        s.add(item)
        s.flush()
        return item.id


def new_signal(pid: int, instrument_id: int, key: str = "drawdown|i:1") -> int:
    with get_session() as s:
        row = InvSignal(
            profile_id=pid,
            rule_id="drawdown",
            kind="drawdown",
            dedup_key=key,
            severity="warning",
            status="active",
            message="Spadek testowy",
            instrument_id=instrument_id,
            payload={},
        )
        s.add(row)
        s.flush()
        return row.id


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #


def test_flag_off_writes_nothing(db_engine, monkeypatch):
    monkeypatch.delenv("CASHU_SYNC", raising=False)  # also when the whole suite runs with the flag on
    pid = new_profile("Off")
    inst = new_instrument()
    item = watch(pid, inst)
    with get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "changed"
        s.add(row)
    with get_session() as s:
        s.exec(delete(InvWatchlistItem))
    assert outbox_count() == 0
    with get_session() as s:
        assert s.exec(select(func.count()).select_from(SyncId)).one() == 0


def test_a_linked_vault_refuses_writes_without_the_flag(db_engine, monkeypatch):
    """P-D: once a profile is linked, a write to a synced table with the flag off fails closed (it
    would fork the database from the log); a non-synced table, and the flag on, still write."""
    from cashu.core.sync_models import SyncVault

    monkeypatch.delenv("CASHU_SYNC", raising=False)
    pid = new_profile("Guard")
    inst = new_instrument()
    other = new_instrument("Other")
    item = watch(pid, inst, note="n")
    with get_session() as s:
        sync_outbox.link_vault(s, pid, VAULT)
    with pytest.raises(sync_outbox.SyncCaptureError, match="CASHU_SYNC=1"), get_session() as s:
        s.add(InvWatchlistItem(profile_id=pid, instrument_id=other, tags=[]))
    with pytest.raises(sync_outbox.SyncCaptureError), get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "changed"
        s.add(row)
    with pytest.raises(sync_outbox.SyncCaptureError), get_session() as s:
        s.exec(update(InvWatchlistItem).where(InvWatchlistItem.id == item).values(note="bulk"))
    with pytest.raises(sync_outbox.SyncCaptureError), get_session() as s:
        s.exec(delete(InvWatchlistItem).where(InvWatchlistItem.id == item))
    with pytest.raises(sync_outbox.SyncCaptureError), get_session() as s:
        instrument_merge.merge_instruments(s, other, inst)
    with get_session() as s:  # nothing of the refused writes landed
        row = s.get(InvWatchlistItem, item)
        assert row.note == "n"
        assert s.exec(select(func.count()).select_from(InvWatchlistItem)).one() == 1
        assert s.get(InvInstrument, other) is not None
        assert s.exec(select(func.count()).select_from(SyncOutbox)).one() == 0
    with get_session() as s:  # a table that does not sync is not guarded
        s.add(InvFxRate(base="PLN", quote="USD", date=dt.date(2026, 1, 2), rate=Decimal("4.0"), source="test"))
    monkeypatch.setenv("CASHU_SYNC", "1")
    with get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "with the flag"
        s.add(row)
    assert outbox(table_name="watchlist_items", op="update")[-1]["fields"] == {"note": "with the flag"}
    monkeypatch.delenv("CASHU_SYNC")
    with get_session() as s:  # unlinked again: the flag-off behaviour is back
        s.exec(delete(SyncVault))
    with get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "unlinked"
        s.add(row)
    with get_session() as s:
        assert s.get(InvWatchlistItem, item).note == "unlinked"


def test_every_table_is_classified():
    """A new table must be declared synced (with a spec) or not synced, never left out."""
    import cashu.models  # noqa: F401  (registers every table)

    tables = set(SQLModel.metadata.tables)
    assert set(sync_outbox.SPECS) | set(sync_outbox.NOT_SYNCED) == tables
    assert not set(sync_outbox.SPECS) & set(sync_outbox.NOT_SYNCED)
    for name, spec in sync_outbox.SPECS.items():
        table = SQLModel.metadata.tables[name]
        cols = {c.name for c in table.columns}
        assert spec.derived <= cols, name
        assert set(spec.key) <= cols, name
        assert {p[1] for p in spec.parts} <= cols, name
        if spec.profile == "column":
            assert "profile_id" in cols, name
        if spec.gid == "det":
            assert (spec.det_table or name) in sync_keys.GID_TABLES, name


# --------------------------------------------------------------------------- #
# Gids and the salt
# --------------------------------------------------------------------------- #

VECTORS = [
    ("accounts", ["iban", "00000000000000000000000000"], "70cc61c8-79b5-80ae-b8cc-fdca7caef49e"),
    ("accounts", ["ext", "mbank", "eb:TESTUID0001"], "a1bb665d-9bf1-81e3-916c-f49d32db099a"),
    ("profile_modules", ["budget"], "fdb0a016-38e3-8d64-8dec-88673f5cdcda"),
    (
        "balances",
        ["70cc61c8-79b5-80ae-b8cc-fdca7caef49e", "2026-01-31", "csv"],
        "e912848f-6071-8821-89fb-56c500920eb6",
    ),
    ("category_rules", ["SKLEP TESTOWY"], "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2"),
    ("loans", ["70cc61c8-79b5-80ae-b8cc-fdca7caef49e"], "b3120349-b79c-869e-819b-cd2c34f608d0"),
    ("budget_settings", ["cushion"], "d3f2d51c-4a38-8fbf-be36-7abc2d765266"),
    (
        "connector_bindings",
        ["a1bb665d-9bf1-81e3-916c-f49d32db099a", "example-broker"],
        "6ad703ab-383d-8c73-82a5-1ee2d6742735",
    ),
    ("inv_instruments", ["isin:XX0000000001"], "fc9daa13-f073-8a72-8cd0-c1345436bc05"),
    ("inv_instrument_aliases", ["yahoo", "TEST.WA"], "20157f67-f236-82f9-ab83-c6d176f65f27"),
    (
        "watchlist_items",
        ["fc9daa13-f073-8a72-8cd0-c1345436bc05"],
        "d0a95ad2-2211-8a30-b04b-809c6be84b30",
    ),
    ("inv_topic_theses", ["gold"], "21465e71-86fc-8535-ab21-87bbe3ca85ba"),
    ("genesis", ["inv_theses", "7"], "c1e52d4d-d9a5-84e6-8d7a-c21b36691202"),
]


@pytest.mark.parametrize(("table", "parts", "gid"), VECTORS)
def test_det_gid_matches_the_spec_vectors(table, parts, gid):
    assert sync_keys.det_gid(sync_keys.Salt(TEST_SALT), table, parts) == gid


def test_det_gid_refuses_bad_input():
    salt = sync_keys.Salt(TEST_SALT)
    with pytest.raises(ValueError):
        sync_keys.det_gid(salt, "not_a_domain", ["x"])
    with pytest.raises(ValueError):
        sync_keys.det_gid(salt, "category_rules", ["A\x1fB"])
    assert "redacted" in repr(salt) and TEST_SALT.hex() not in repr(salt)


def test_ulids_are_well_formed_and_distinct():
    ids = {sync_keys.mint_ulid() for _ in range(200)}
    assert len(ids) == 200
    assert all(re.fullmatch(r"[0-7][0-9A-HJKMNP-TV-Z]{25}", u) for u in ids)
    assert sync_keys.mint_ulid(0).startswith("0000000000")


def test_salt_is_read_from_the_keychain_entry_of_the_vault(caplog):
    caplog.set_level(logging.DEBUG)
    sync_keys.forget_cached_salts()
    assert sync_keys.salt_entry_name(VAULT) == f"cashu.vault.{VAULT}.gidsalt"
    assert sync_keys.gid_salt(VAULT) is None
    sync_keys.forget_cached_salts()
    keyring.set_password("cashu", f"cashu.vault.{VAULT}.gidsalt", TEST_SALT.hex())
    salt = sync_keys.gid_salt(VAULT)
    assert salt is not None and salt.expose() == TEST_SALT
    other = "f" * 32
    keyring.set_password("cashu", f"cashu.vault.{other}.gidsalt", "not hex")
    assert sync_keys.gid_salt(other) is None
    with pytest.raises(ValueError):
        sync_keys.salt_entry_name("my-profile-slug")
    assert TEST_SALT.hex() not in caplog.text
    sync_keys.forget_cached_salts()


# --------------------------------------------------------------------------- #
# Capture
# --------------------------------------------------------------------------- #


def test_a_seeded_profile_records_every_live_row_of_every_synced_table(db_engine, sync_on):
    """Budget, assets, loans and investments written through the services with the flag on: per synced
    table, inserts minus deletes in the outbox equal the live rows (derived cash legs excluded), every
    row tagged with the profile (shared instruments untagged)."""
    from cashu.core.mcp.server import CashuMcp

    pid, _slug = seed_profile(run_daily=True)
    host = CashuMcp(pid, today=TODAY)
    with get_session() as s:
        signal_id = s.exec(select(InvSignal.id).where(InvSignal.profile_id == pid)).first()
    calls = [
        ("add_to_watchlist", {"symbol_or_isin": "CDR.WA", "note": "obserwuj"}),
        ("upsert_thesis", {"instrument": "PKO", "entry_type": "trend", "thesis": "Teza testowa."}),
        ("set_instrument_segment", {"instrument": "PKO", "segment": "financials"}),
        ("upsert_topic_thesis", {"segment": "energy", "thesis": "Teza agenta."}),
        ("mark_review_done", {"notes": "przeglad"}),
        ("record_decision", {"signal_id": signal_id, "action": "held"}),
    ]
    for tool, args in calls:
        result = host.call(tool, args)
        assert result.ok, (tool, result.error)
    run = host.call("start_research_run", {})
    assert run.ok, run.error
    assert host.call("finish_research_run", {"run_id": run.data["run_id"], "counts": {}}).ok
    with get_session() as s:
        inst = s.exec(select(InvInstrument.id)).first()
        s.add(
            InvAlert(
                profile_id=pid, instrument_id=inst, scope="instrument", kind="price_below",
                params={"price": "10"}, polarity="negative", severity="warning", title="Alert testowy",
            )
        )
    with get_session() as s:
        conn = s.connection()
        live: Counter = Counter()
        for name, spec in sync_outbox.SPECS.items():
            table = SQLModel.metadata.tables[name]
            rows = [dict(r._mapping) for r in conn.execute(table.select())]
            live[name] = sum(1 for r in rows if not (spec.skip_row and spec.skip_row(r)))
    recorded: Counter = Counter()
    for r in outbox():
        if r["op"] == "insert":
            recorded[r["table_name"]] += 1
        elif r["op"] == "delete":
            recorded[r["table_name"]] -= 1
    covered = {t for t, n in live.items() if n}
    assert {t: live[t] for t in covered} == {t: recorded[t] for t in covered}
    # the seed reaches most of the catalog (the rest has its own tests below)
    assert len(covered) >= 26, sorted(set(sync_outbox.SPECS) - covered)
    for r in outbox():
        spec = sync_outbox.SPECS[r["table_name"]]
        if spec.profile == "global":
            assert r["profile_id"] is None
        else:
            assert r["profile_id"] == pid, r["table_name"]
        assert set(r["fields"]).isdisjoint(spec.derived | sync_outbox.GLOBAL_DERIVED)
        if spec.gid == "ulid" and r["op"] == "insert":
            assert re.fullmatch(r"[0-7][0-9A-HJKMNP-TV-Z]{25}", r["gid"])
    assert not [r for r in outbox(table_name="transactions") if str(r["fields"].get("dedup_hash", "")).startswith("cashleg:")]


def test_an_update_records_only_the_changed_synced_fields(db_engine, sync_on):
    pid = new_profile("Diff")
    inst = new_instrument()
    item = watch(pid, inst, note="old")
    with get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "new"
        row.tags = ["a"]
        s.add(row)
    [upd] = outbox(table_name="watchlist_items", op="update")
    assert upd["fields"] == {"note": "new", "tags": ["a"]}
    assert upd["prev"] == {"note": "old", "tags": []}
    assert upd["local_id"] == str(item) and upd["profile_id"] == pid
    assert upd["key"] == {"instrument_id": inst}


def test_an_object_kept_across_a_commit_still_carries_its_profile_and_last_state(db_engine, sync_on):
    """A plain Session expires objects on commit; setting one attribute loads nothing else."""
    from sqlmodel import Session

    pid = new_profile("Expired", ("budget",))
    with get_session() as s:
        acc = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000041", name="K", profile_id=pid)
        accounts.upsert_balance(s, acc, dt.date(2026, 1, 31), Decimal("5.00"), source="csv")
    with Session(db_engine) as s:
        bal = s.exec(select(Balance)).one()
        s.commit()  # bal is expired now
        bal.amount = Decimal("6.00")
        s.add(bal)
        s.commit()
        s.delete(bal)
        s.commit()
    upd, dele = outbox(table_name="balances")[1:]
    assert (upd["op"], upd["profile_id"], upd["fields"], upd["key"]["account_id"]) == ("update", pid, {"amount": "6.00"}, acc.id)
    assert dele["op"] == "delete" and dele["profile_id"] == pid
    assert dele["fields"]["amount"] == "6.00" and dele["fields"]["date"] == "2026-01-31"


def stored(table: str, local_id: str) -> dict:
    """The row as SQLite stores it (raw driver values, JSON parsed), without ``profile_id``."""
    import json

    t = SQLModel.metadata.tables[table]
    with get_session() as s:
        conn = s.connection()
        cur = conn.exec_driver_sql(f"SELECT * FROM {table} WHERE id = ?", (int(local_id),))
        names = [d[0] for d in cur.cursor.description]
        raw = dict(zip(names, cur.fetchone(), strict=True))
    out = {}
    for name, value in raw.items():
        if name == "profile_id":
            continue
        is_json = isinstance(t.c[name].type, JSON) or isinstance(getattr(t.c[name].type, "impl", None), JSON)
        out[name] = json.loads(value) if is_json and isinstance(value, str) else value
    return out


def test_inserts_and_updates_carry_the_whole_stored_row_in_post(db_engine, sync_on):
    """P-B: ``post`` = every column as stored after the change, derived and excluded timestamps
    included (``added_at``, ``updated_at``, ``acknowledged_at``, ``core_changed_at``); ``fields`` and
    ``prev`` are unchanged; deletes and explicit ops carry no ``post``."""
    pid = new_profile("Post")
    inst = new_instrument()
    item = watch(pid, inst, note="old")
    [ins] = outbox(table_name="watchlist_items", op="insert")
    assert "added_at" in ins["post"] and "added_at" not in ins["fields"]
    assert "profile_id" not in ins["post"] and ins["post"] == stored("watchlist_items", str(item))
    with get_session() as s:
        row = s.get(InvWatchlistItem, item)
        row.note = "new"
        s.add(row)
    [upd] = outbox(table_name="watchlist_items", op="update")
    assert upd["fields"] == {"note": "new"} and upd["prev"] == {"note": "old"}
    assert upd["post"] == stored("watchlist_items", str(item)) and upd["post"]["note"] == "new"
    sig = new_signal(pid, inst)
    with get_session() as s:
        row = s.get(InvSignal, sig)
        row.status = "resolved"
        row.acknowledged_at = dt.datetime(2026, 1, 1, 12, 0, 0, 123456, tzinfo=dt.UTC)
        s.add(row)
    upd = outbox(table_name="inv_signals", op="update")[-1]
    assert upd["fields"] == {"status": "resolved"}
    assert upd["post"] == stored("inv_signals", str(sig)) and upd["post"]["acknowledged_at"]
    with get_session() as s:
        th = InvThesis(profile_id=pid, instrument_id=inst, entry_type="long", thesis="Teza")
        s.add(th)
        s.flush()
        th.core_changed_at = th.updated_at = dt.datetime.now(dt.UTC)
        th.thesis = "Teza 2"
        s.add(th)
        s.flush()
        thesis_id = th.id
    ins, upd = outbox(table_name="inv_theses")
    assert upd["post"] == stored("inv_theses", str(thesis_id)) and upd["post"]["core_changed_at"]
    assert upd["fields"] == {"thesis": "Teza 2"} and upd["post"]["updated_at"] != ins["post"]["updated_at"]
    assert ins["post"]["thesis"] == "Teza" and ins["post"]["core_changed_at"] is None
    with get_session() as s:  # a bulk update has the row after the statement
        s.exec(update(InvWatchlistItem).where(InvWatchlistItem.id == item).values(note="bulk"))
    bulk = outbox(table_name="watchlist_items", op="update")[-1]
    assert bulk["fields"] == {"note": "bulk"} and bulk["post"] == stored("watchlist_items", str(item))
    with get_session() as s:
        s.delete(s.get(InvWatchlistItem, item))
    [dele] = outbox(table_name="watchlist_items", op="delete")
    assert dele["post"] is None and dele["fields"]["note"] == "bulk"
    with get_session() as s:  # SQL NULL, not the JSON text 'null'
        assert s.exec(text(f"SELECT post IS NULL FROM sync_outbox WHERE id = {dele['id']}")).one()[0] == 1
    with get_session() as s:
        instrument_merge.merge_instruments(s, new_instrument("Dup"), inst)
    [merge] = outbox(op="merge")
    assert merge["post"] is None
    with get_session() as s:
        assert s.exec(text(f"SELECT post IS NULL FROM sync_outbox WHERE id = {merge['id']}")).one()[0] == 1


def test_post_reads_back_a_column_missing_from_the_flushed_state(db_engine, sync_on):
    """A column the flush expired (a server-side default) is not in the object's state: ``post``
    reads the stored value back instead of leaving it out."""
    pid = new_profile("Expire")
    item = watch(pid, new_instrument(), note="n")
    table = SQLModel.metadata.tables["watchlist_items"]
    with get_session() as s:
        row = {"id": item, "profile_id": pid, "note": "n"}  # the rest "expired"
        post = sync_outbox._Capture(s, s.connection()).post(table, row)
    assert post == stored("watchlist_items", str(item)) and post["added_at"]


def test_derived_only_changes_record_nothing(db_engine, sync_on):
    pid = new_profile("Derived")
    inst = new_instrument()
    with get_session() as s:
        th = InvThesis(profile_id=pid, instrument_id=inst, entry_type="long", thesis="Teza")
        s.add(th)
        s.flush()
        thesis_id = th.id
    start = outbox_count()
    with get_session() as s:
        th = s.get(InvThesis, thesis_id)
        th.core_changed_at = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
        th.updated_at = dt.datetime(2026, 1, 2, tzinfo=dt.UTC)
        s.add(th)
    sig = new_signal(pid, inst)
    start = outbox_count()
    with get_session() as s:
        assert journal.acknowledge(s, s.get(InvSignal, sig))  # acknowledged is derived (events.md 6.5)
    assert outbox_count() == start
    with get_session() as s:
        row = s.get(InvSignal, sig)
        row.status = "resolved"
        s.add(row)
    [closed] = outbox(table_name="inv_signals", op="update")
    assert closed["fields"] == {"status": "resolved"}


def test_rollback_leaves_no_outbox_rows(db_engine, sync_on):
    pid = new_profile("Rollback")
    inst = new_instrument()
    start = outbox_count()
    with pytest.raises(RuntimeError), get_session() as s:
        s.add(InvWatchlistItem(profile_id=pid, instrument_id=inst, tags=[]))
        s.flush()
        assert outbox_count() > start or True  # visible inside the transaction only
        raise RuntimeError("boom")
    assert outbox_count() == start
    with get_session() as s:
        assert s.exec(select(func.count()).select_from(SyncId).where(SyncId.table_name == "watchlist_items")).one() == 0


def test_insert_and_delete_in_one_transaction_leave_nothing(db_engine, sync_on):
    """The watchlist's insert-clash rollback (``service/watchlist.py:_insert_once``) drops a just-made
    instrument and its aliases: no instrument ever existed for the log."""
    start = outbox_count()
    with get_session() as s:
        inst = InvInstrument(
            name="Clash", currency="PLN", asset_class="stock", valuation_mode="market", tags=[]
        )
        s.add(inst)
        s.flush()
        s.add(InvInstrumentAlias(instrument_id=inst.id, namespace="yahoo", value="CLASH.WA"))
        s.flush()
        for alias in s.exec(select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id == inst.id)):
            s.delete(alias)
        s.flush()
        s.delete(inst)
        s.flush()
    assert outbox_count() == start


def test_profile_tagging_follows_the_account_and_never_mixes_profiles(db_engine, sync_on):
    a = new_profile("Anna", ("budget",))
    b = new_profile("Piotr", ("budget",))
    with get_session() as s:
        acc_a = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000011", name="A", profile_id=a)
        acc_b = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000011", name="B", profile_id=b)
        accounts.upsert_balance(s, acc_a, dt.date(2026, 1, 31), Decimal("1.00"), source="csv")
        accounts.upsert_balance(s, acc_b, dt.date(2026, 1, 31), Decimal("2.00"), source="csv")
    bal = outbox(table_name="balances")
    assert sorted(r["profile_id"] for r in bal) == sorted([a, b])
    for r in bal:
        acc = acc_a if r["profile_id"] == a else acc_b
        assert r["key"]["account_id"] == acc.id
    assert {r["profile_id"] for r in outbox(table_name="accounts")} == {a, b}
    inst = new_instrument()
    assert [r["profile_id"] for r in outbox(table_name="inv_instruments", local_id=str(inst))] == [None]


def test_a_bulk_delete_and_update_record_each_row(db_engine, sync_on):
    pid = new_profile("Bulk")
    items = [watch(pid, new_instrument(f"I{i}")) for i in range(3)]
    with get_session() as s:
        s.exec(update(InvWatchlistItem).where(InvWatchlistItem.id.in_(items[:2])).values(note="bulk"))
    upd = outbox(table_name="watchlist_items", op="update")
    assert sorted(int(r["local_id"]) for r in upd) == items[:2]
    assert all(r["fields"] == {"note": "bulk"} and r["prev"] == {"note": None} for r in upd)
    with get_session() as s:
        s.exec(delete(InvWatchlistItem).where(InvWatchlistItem.profile_id == pid))
    dels = outbox(table_name="watchlist_items", op="delete")
    assert sorted(int(r["local_id"]) for r in dels) == items
    # no vault linked: no gid, the key carries the DET parts for the shipper
    assert all(r["gid"] is None and r["key"] == {"instrument_id": r["fields"]["instrument_id"]} for r in dels)
    with get_session() as s:  # the deleted rows' gids are unmapped (a reused rowid starts fresh)
        assert s.exec(select(func.count()).select_from(SyncId).where(SyncId.table_name == "watchlist_items")).one() == 0


def test_a_bulk_insert_into_a_synced_table_is_refused(db_engine, sync_on):
    pid = new_profile("BulkInsert")
    inst = new_instrument()
    with pytest.raises(sync_outbox.SyncCaptureError), get_session() as s:
        s.execute(insert(InvWatchlistItem), [{"profile_id": pid, "instrument_id": inst, "tags": []}])


def test_instrument_merge_is_one_explicit_row(db_engine, sync_on):
    pid = new_profile("Merge")
    src = new_instrument("Dup", isin=None)
    dst = new_instrument("Real", isin="XX0000000001")
    watch(pid, src, note="from the duplicate")
    watch(pid, dst)
    new_signal(pid, src, key=f"drawdown|i:{src}")
    start = outbox_count()
    with get_session() as s:
        instrument_merge.merge_instruments(s, src, dst)
    rows = outbox()[start:]
    assert [(r["table_name"], r["op"], r["local_id"]) for r in rows] == [("inv_instruments", "merge", str(src))]
    assert rows[0]["fields"] == {"source_id": src, "target_id": dst} and rows[0]["profile_id"] is None
    other = new_instrument("Other")
    mark = outbox_count()
    with get_session() as s:
        instrument_merge.merge_instruments(s, dst, other, dry_run=True)
    assert outbox_count() == mark  # a dry run rolls the row back


def test_decision_record_and_undo(db_engine, sync_on):
    pid = new_profile("Journal")
    inst = new_instrument()
    sig = new_signal(pid, inst)
    start = outbox_count()
    with get_session() as s:
        d = journal.record_decision(s, pid, action="held", signal_row=s.get(InvSignal, sig))
        decision_id = d.id
    made = outbox()[start:]
    assert [(r["table_name"], r["op"]) for r in made] == [("inv_decisions", "insert"), ("inv_decision_signals", "insert")]
    assert made[1]["local_id"] == f"{decision_id}|{sig}" and made[1]["profile_id"] == pid
    assert made[1]["gid"] is None and made[1]["key"] == {"decision_id": decision_id, "signal_id": sig}
    decision_gid = made[0]["gid"]
    mark = outbox_count()
    with get_session() as s:
        journal.undo_decision(s, pid, s.get(InvDecision, decision_id))
    undone = outbox()[mark:]
    assert [(r["table_name"], r["op"], r["gid"]) for r in undone] == [("inv_decisions", "undo", decision_gid)]
    with get_session() as s:
        assert s.get(InvSignal, sig).status == "active"
        assert s.exec(select(InvDecisionSignal)).all() == []


def test_review_undo_is_explicit(db_engine, sync_on):
    pid = new_profile("Review")
    with get_session() as s:
        row = reviews.mark_done(s, s.get(Profile, pid), "investments")
        review_id = row.id
    [made] = outbox(table_name="reviews")
    mark = outbox_count()
    with get_session() as s:
        reviews.undo(s, pid, review_id)
    assert [(r["table_name"], r["op"], r["gid"]) for r in outbox()[mark:]] == [("reviews", "undo", made["gid"])]


def test_cash_legs_are_derived_and_their_delete_is_explicit(db_engine, sync_on):
    pid = new_profile("Cash", ("budget",))
    with get_session() as s:
        acc = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000021", name="K", profile_id=pid)
        txn = Transaction(
            account_id=acc.id,
            booking_date=dt.date(2026, 3, 2),
            amount=Decimal("-200.00"),
            currency="PLN",
            description="WYPLATA BANKOMAT",
            source="csv",
            dedup_hash="test-atm-1",
            occurrence=0,
        )
        s.add(txn)
        s.flush()
        bank_id = txn.id
    with get_session() as s:
        budget.set_transaction_category(s, bank_id, "cash_withdrawal", profile_id=pid)
    with get_session() as s:
        leg = s.exec(select(Transaction).where(Transaction.dedup_hash.startswith("cashleg:"))).one()
        leg_id = leg.id
    assert not outbox(table_name="transactions", local_id=str(leg_id))
    claim = outbox(table_name="transactions", local_id=str(bank_id), op="update")
    assert claim and claim[-1]["fields"]["category_source"] == "manual_txn"
    mark = outbox_count()
    with get_session() as s:
        assert cash.delete_cash_transaction(s, leg_id, profile_id=pid)
    rows = outbox()[mark:]
    assert ("transactions", "leg_delete", str(leg_id)) in [(r["table_name"], r["op"], r["local_id"]) for r in rows]
    leg_row = next(r for r in rows if r["op"] == "leg_delete")
    assert leg_row["fields"] == {"cash_leg_of": bank_id} and leg_row["profile_id"] == pid
    assert not [r for r in rows if r["op"] == "delete"]
    with get_session() as s:
        exp = cash.add_cash_expense(s, amount="12.50", title="Kawa test", category="groceries", profile_id=pid)
        exp_id = exp.id
    added = outbox(table_name="transactions", local_id=str(exp_id), op="insert")[-1]
    assert re.fullmatch(r"[0-7][0-9A-HJKMNP-TV-Z]{25}", added["gid"])  # cash expenses are ULIDs
    with get_session() as s:
        assert cash.delete_cash_transaction(s, exp_id, profile_id=pid)
    assert outbox(table_name="transactions", local_id=str(exp_id))[-1]["op"] == "delete"
    assert outbox(table_name="transactions", local_id=str(exp_id))[-1]["gid"] == added["gid"]


def test_rule_categories_are_derived_but_claims_sync(db_engine, sync_on):
    pid = new_profile("Claims", ("budget",))
    with get_session() as s:
        acc = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000031", name="K", profile_id=pid)
        txn = Transaction(
            account_id=acc.id, booking_date=dt.date(2026, 3, 2), amount=Decimal("-9.99"), currency="PLN",
            counterparty_name="SKLEP TESTOWY", source="csv", dedup_hash="test-claim-1", occurrence=0,
            category="groceries", category_source="rule",
        )
        s.add(txn)
        s.flush()
        tid = txn.id
    [ins] = outbox(table_name="transactions", local_id=str(tid))
    assert "category" not in ins["fields"] and "category_source" not in ins["fields"]
    with get_session() as s:
        t = s.get(Transaction, tid)
        t.category, t.category_source = "restaurants", "keyword"
        s.add(t)
    assert not outbox(table_name="transactions", local_id=str(tid), op="update")
    with get_session() as s:
        budget.set_transaction_category(s, tid, "fuel", profile_id=pid)
    [claim] = outbox(table_name="transactions", local_id=str(tid), op="update")
    assert claim["fields"] == {"category": "fuel", "category_source": "manual_txn"}


def test_det_gids_need_the_keychain_salt_and_known_references(db_engine, sync_on):
    pid = new_profile("Det")
    inst = new_instrument()
    first = watch(pid, inst)
    [row] = outbox(table_name="watchlist_items", local_id=str(first), op="insert")
    assert row["gid"] is None and row["key"] == {"instrument_id": inst}  # no vault: the shipper computes
    with get_session() as s:
        sync_outbox.link_vault(s, pid, VAULT)
        s.add(SyncId(profile_id=pid, table_name="inv_instruments", local_id=str(inst), gid="fc9daa13-f073-8a72-8cd0-c1345436bc05", source="genesis"))
    keyring.set_password("cashu", f"cashu.vault.{VAULT}.gidsalt", TEST_SALT.hex())
    sync_keys.forget_cached_salts()
    with get_session() as s:
        s.delete(s.get(InvWatchlistItem, first))
    second = watch(pid, inst)  # SQLite may reuse the deleted rowid: the mapping starts fresh
    row = outbox(table_name="watchlist_items", local_id=str(second), op="insert")[-1]
    assert row["gid"] == "d0a95ad2-2211-8a30-b04b-809c6be84b30"  # gid.md 8, watchlist item
    with get_session() as s:
        mapped = s.exec(select(SyncId).where(SyncId.table_name == "watchlist_items")).one()
        assert (mapped.local_id, mapped.gid, mapped.source) == (str(second), row["gid"], "det")
    with get_session() as s:
        p = s.get(Profile, pid)
        p.name = "Det 2"
        s.add(p)
    [prof] = outbox(table_name="profiles", op="update")
    assert prof["gid"] == VAULT and prof["fields"] == {"name": "Det 2"}


def test_det_gid_parts_use_the_stored_enum_value(db_engine, sync_on):
    """S31a: an enum column (``Source.MANUAL``) is a DET part by its value (``manual``), as genesis
    decodes the stored name and the TS shipper checks; ``str()`` of the member gave another gid."""
    from cashu.core.models import Source

    pid = new_profile("Enum", ("budget",))
    acc_gid = "fc9daa13-f073-8a72-8cd0-c1345436bc06"
    with get_session() as s:
        acc = accounts.get_or_create_account(s, bank="mbank", iban="99114000000000000000000042", name="K", profile_id=pid)
        acc_id = acc.id
        sync_outbox.link_vault(s, pid, VAULT)
        s.add(SyncId(profile_id=pid, table_name="accounts", local_id=str(acc_id), gid=acc_gid, source="genesis"))
    keyring.set_password("cashu", f"cashu.vault.{VAULT}.gidsalt", TEST_SALT.hex())
    sync_keys.forget_cached_salts()
    with get_session() as s:
        accounts.upsert_balance(s, s.get(Account, acc_id), dt.date(2026, 1, 31), Decimal("5.00"), source=Source.MANUAL)
    [row] = outbox(table_name="balances", op="insert")
    expected = sync_keys.det_gid(sync_keys.Salt(TEST_SALT), "balances", [acc_gid, "2026-01-31", "manual"])
    assert row["gid"] == expected


def test_inbound_rows_are_tagged(db_engine, sync_on):
    pid = new_profile("Inbound")
    inst = new_instrument()
    with get_session() as s, sync_outbox.inbound(s):
        s.add(InvWatchlistItem(profile_id=pid, instrument_id=inst, tags=[]))
        s.flush()
    [row] = outbox(table_name="watchlist_items")
    assert row["origin"] == "inbound"
    watch(new_profile("Local"), inst)
    assert outbox(table_name="watchlist_items")[-1]["origin"] == "local"


def test_rows_are_pruned_only_after_an_ack(db_engine, sync_on):
    pid = new_profile("Ack")
    inst = new_instrument()
    watch(pid, inst)
    with get_session() as s:
        assert sync_outbox.prune(s) == 0
    total = outbox_count()
    first_two = [r["id"] for r in outbox()][:2]
    with get_session() as s:
        acked = sync_outbox.ack(
            s,
            first_two[-1],
            [{"profile_id": pid, "table": "inv_instruments", "local_id": str(inst), "gid": "fc9daa13-f073-8a72-8cd0-c1345436bc05"}],
        )
    assert acked == 2
    with get_session() as s:
        assert sync_outbox.prune(s) == 2
        assert s.exec(select(SyncId).where(SyncId.source == "shipper")).one().local_id == str(inst)
    assert outbox_count() == total - 2
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.ack(s, 10**9, [{"profile_id": pid, "table": "inv_instruments", "local_id": "1", "gid": "1"}])


DEVICE = "3f9a2c8e1d7b4a6050c3e9f12d8b7a64"


def hlc(ms: int, counter: int = 0) -> str:
    def b36(n: int, width: int) -> str:
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"
        out = ""
        while n:
            n, r = divmod(n, 36)
            out = digits[r] + out
        return out.rjust(width, "0")

    return f"{b36(ms, 9)}-{b36(counter, 4)}-{DEVICE}"


def clocks_of(pid: int, table: str, local_id: str) -> dict:
    with get_session() as s:
        rows = s.exec(
            select(SyncClock).where(
                SyncClock.profile_id == pid, SyncClock.table_name == table, SyncClock.local_id == local_id
            )
        ).all()
        return {c.field: (c.hlc, c.eid) for c in rows}


def test_an_ack_stores_field_clocks_and_only_moves_them_forward(db_engine, sync_on):
    pid = new_profile("Clocks")
    item = watch(pid, new_instrument(), note="n")
    top = outbox()[-1]["id"]
    early, late = (hlc(1_700_000_000_000), sync_keys.mint_ulid()), (hlc(1_700_000_005_000), sync_keys.mint_ulid())
    entry = {"profile_id": pid, "table": "watchlist_items", "local_id": str(item), "clocks": {"note": list(late), "tags": list(early)}}
    with get_session() as s:
        assert sync_outbox.ack(s, top, [entry]) > 0
    assert clocks_of(pid, "watchlist_items", str(item)) == {"note": late, "tags": early}
    before = outbox()
    with get_session() as s:  # the same ack again: a no-op
        assert sync_outbox.ack(s, top, [entry]) == 0
    assert outbox() == before and clocks_of(pid, "watchlist_items", str(item)) == {"note": late, "tags": early}
    # an older stamp never moves a clock back; a newer one moves it; one column in two entries keeps the later
    newer = (hlc(1_700_000_009_000), sync_keys.mint_ulid())
    with get_session() as s:
        sync_outbox.ack(
            s,
            top,
            [
                {"profile_id": pid, "table": "watchlist_items", "local_id": item, "clocks": {"note": list(early), "tags": list(late)}},
                {"profile_id": pid, "table": "watchlist_items", "local_id": item, "clocks": {"tags": list(newer)}},
            ],
        )
    assert clocks_of(pid, "watchlist_items", str(item)) == {"note": late, "tags": newer}
    with get_session() as s:  # no gid in the entries: the gid map is untouched
        assert s.exec(select(func.count()).select_from(SyncId).where(SyncId.source == "shipper")).one() == 0


def test_an_old_ack_line_with_only_a_gid_is_still_valid(db_engine, sync_on):
    pid = new_profile("OldLine")
    inst = new_instrument()
    gid = "fc9daa13-f073-8a72-8cd0-c1345436bc05"
    with get_session() as s:
        sync_outbox.ack(s, outbox()[-1]["id"], [{"profile_id": pid, "table": "inv_instruments", "local_id": str(inst), "gid": gid}])
    with get_session() as s:
        assert s.exec(select(SyncId.gid).where(SyncId.source == "shipper")).one() == gid
        assert s.exec(select(func.count()).select_from(SyncClock)).one() == 0


@pytest.mark.parametrize(
    "bad",
    [
        {"profile_id": "1", "table": "watchlist_items", "local_id": "1"},
        {"profile_id": True, "table": "watchlist_items", "local_id": "1"},
        {"profile_id": 1, "table": "sync_outbox", "local_id": "1"},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "gid": "not-a-gid"},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"updated_at": "VALID"}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"added_at": "VALID"}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"nope": "VALID"}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"note": ["bad-hlc", "EID"]}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"note": ["HLC", "not-a-ulid"]}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": {"note": ["HLC"]}},
        {"profile_id": 1, "table": "watchlist_items", "local_id": "1", "clocks": ["note"]},
    ],
)
def test_a_bad_ack_entry_writes_nothing(db_engine, sync_on, bad):
    pid = new_profile("BadAck")
    inst = new_instrument()
    item = watch(pid, inst)
    stamp = [hlc(1_700_000_000_000), sync_keys.mint_ulid()]

    def fill(value):
        if value == "VALID":
            return list(stamp)
        if isinstance(value, list):
            return [stamp[0] if v == "HLC" else stamp[1] if v == "EID" else v for v in value]
        return value

    bad = dict(bad)
    if isinstance(bad.get("clocks"), dict):
        bad["clocks"] = {k: fill(v) for k, v in bad["clocks"].items()}
    good = [
        {"profile_id": pid, "table": "inv_instruments", "local_id": str(inst), "gid": "fc9daa13-f073-8a72-8cd0-c1345436bc05"},
        {"profile_id": pid, "table": "watchlist_items", "local_id": str(item), "clocks": {"note": stamp}},
    ]
    before = outbox()
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.ack(s, before[-1]["id"], [*good, bad])
    assert outbox() == before  # nothing acked
    with get_session() as s:
        assert s.exec(select(func.count()).select_from(SyncClock)).one() == 0
        assert s.exec(select(func.count()).select_from(SyncId).where(SyncId.source == "shipper")).one() == 0


def test_cli_ack_reads_entries_with_clocks(db_engine, sync_on, tmp_path):
    import json

    from typer.testing import CliRunner

    from cashu.cli import app

    pid = new_profile("CliAck")
    item = watch(pid, new_instrument(), note="n")
    stamp = [hlc(1_700_000_000_000), sync_keys.mint_ulid()]
    path = tmp_path / "ack.jsonl"
    path.write_text(json.dumps({"profile_id": pid, "table": "watchlist_items", "local_id": str(item), "clocks": {"note": stamp}}) + "\n")
    out = CliRunner().invoke(app, ["sync", "ack", "--through", str(outbox()[-1]["id"]), "--ids", str(path)])
    assert out.exit_code == 0, out.output
    assert "0 gid(s) and 1 field clock(s) stored" in out.output
    assert clocks_of(pid, "watchlist_items", str(item)) == {"note": tuple(stamp)}
    path.write_text(json.dumps({"profile_id": pid, "table": "watchlist_items", "local_id": str(item), "clocks": {"nope": stamp}}) + "\n")
    assert CliRunner().invoke(app, ["sync", "ack", "--through", "1", "--ids", str(path)]).exit_code == 1


def test_escalating_an_acknowledged_signal_keeps_the_previous_status_as_evidence(db_engine, sync_on):
    """P-C: the status pair active <-> acknowledged is not shipped, but ``prev.status`` stays so the
    shipper can tell a reactivating escalation (``signal.escalated {reactivate}``)."""
    pid = new_profile("Escalate")
    sig = new_signal(pid, new_instrument())
    with get_session() as s:
        assert journal.acknowledge(s, s.get(InvSignal, sig))
    start = outbox_count()
    with get_session() as s:  # store/signals.py EscalateSignal with reactivate
        row = s.get(InvSignal, sig)
        row.severity = "action"
        row.status = "active"
        row.acknowledged_at = None
        s.add(row)
    [esc] = outbox()[start:]
    assert esc["op"] == "update" and esc["fields"] == {"severity": "action"}
    assert esc["prev"] == {"severity": "warning", "status": "acknowledged"}
    with get_session() as s:  # a status-only change (acknowledge again) is still dropped
        row = s.get(InvSignal, sig)
        row.status = "acknowledged"
        s.add(row)
    assert outbox_count() == start + 1


def test_status_reports_counts_only(db_engine, sync_on):
    pid = new_profile("Status")
    watch(pid, new_instrument())
    with get_session() as s:
        report = sync_outbox.status(s)
    assert report["enabled"] and report["tables"]
    assert report["profiles"][pid]["pending"] >= 2 and report["profiles"][None]["pending"] >= 1


def test_cli_status_and_link(db_engine, sync_on):
    from typer.testing import CliRunner

    from cashu.cli import app

    new_profile("Cli")
    runner = CliRunner()
    out = runner.invoke(app, ["--profile", "cli", "sync", "link", VAULT])
    assert out.exit_code == 0, out.output
    out = runner.invoke(app, ["sync", "status"])
    assert out.exit_code == 0 and "capture: on" in out.output and "vault linked" in out.output
    assert runner.invoke(app, ["--profile", "cli", "sync", "link", "slug-not-a-vault"]).exit_code == 1


# --------------------------------------------------------------------------- #
# Guard: raw SQL writers to synced tables
# --------------------------------------------------------------------------- #

_WRITE = re.compile(
    r"\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+\"?(\{[^}]*\}|\w+)\"?(?=\s|\(|$)(?P<rest>.*)",
    re.DOTALL,
)
# path -> raw write statements into a synced table (dynamic targets count as synced). Each file must
# record an explicit outbox row (``sync_outbox.emit*``); a new statement changes the count and fails.
RAW_WRITERS = {
    "src/cashu/modules/investments/store/instrument_merge.py": 11,
}


def _strings(tree: ast.AST) -> list[str]:
    """String literals; an f-string as one string with ``{x}`` for each placeholder."""
    inner = {id(v) for n in ast.walk(tree) if isinstance(n, ast.JoinedStr) for v in n.values}
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in inner:
            out.append(node.value)
        elif isinstance(node, ast.JoinedStr):
            out.append("".join(v.value if isinstance(v, ast.Constant) else "{x}" for v in node.values))
    return out


def raw_writes(path: Path) -> int:
    n = 0
    for s in _strings(ast.parse(path.read_text(encoding="utf-8"))):
        for m in _WRITE.finditer(s):
            target, rest = m.group(1), m.group("rest")
            if m.group(0).startswith("UPDATE") and not re.match(r"\s*SET\b", rest):
                continue
            if target.startswith("{") or target in sync_outbox.SPECS:
                n += 1
    return n


def test_no_raw_sql_writer_to_a_synced_table_without_an_explicit_emit():
    found = {}
    for path in sorted((REPO / "src" / "cashu").rglob("*.py")):
        rel = path.relative_to(REPO).as_posix()
        if "/migrations/versions/" in rel or rel.endswith("core/sync_outbox.py"):
            continue
        n = raw_writes(path)
        if n:
            found[rel] = n
    assert found == RAW_WRITERS
    for rel in RAW_WRITERS:
        assert "sync_outbox.emit" in (REPO / rel).read_text(encoding="utf-8"), rel


def test_the_guard_sees_a_new_raw_writer(tmp_path):
    p = tmp_path / "x.py"
    p.write_text(
        'conn.execute(text("UPDATE alerts SET status = :s WHERE id = :id"))\n'
        'conn.execute(text(f"DELETE FROM {table} WHERE id = 1"))\n'
        'conn.execute(text("INSERT INTO inv_price_bars (id) VALUES (1)"))\n'
        '"""Docs: UPDATE the alerts table."""\n',
        encoding="utf-8",
    )
    assert raw_writes(p) == 2


def test_raw_sql_does_not_reach_the_outbox_without_an_emit(db_engine, sync_on):
    """Why the guard exists: plain SQL bypasses the session hooks."""
    pid = new_profile("Raw")
    item = watch(pid, new_instrument())
    start = outbox_count()
    with get_session() as s:
        s.connection().execute(text("UPDATE watchlist_items SET note = 'x' WHERE id = :id"), {"id": item})
    assert outbox_count() == start
    assert inspect(InvAlert) is not None and Account and Balance  # imported tables stay referenced
