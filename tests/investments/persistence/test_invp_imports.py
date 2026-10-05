"""ImportService: preview notes, commit atomicity and re-resolution, duplicates, corporate actions,
reconciliation corrections, generic CSV mappings, the archive."""

from __future__ import annotations

from decimal import Decimal

import pytest
from invp_support import HEADER, ROWS, add_account, canonical_csv, import_file, make_profile
from sqlmodel import func, select

from finanse.core import paths, profiles
from finanse.core.db import get_session
from finanse.modules.investments.domain import AssetClass, Currency, Instrument
from finanse.modules.investments.importing import ImportFile
from finanse.modules.investments.models import (
    InvAccountSettings,
    InvImportBatch,
    InvInstrument,
    InvInstrumentAlias,
    InvInstrumentRename,
    InvManualValuation,
    InvPositionSnapshot,
    InvTransaction,
)
from finanse.modules.investments.service import imports
from finanse.modules.investments.store import instruments


@pytest.fixture
def setup(db_engine):
    pid, slug = make_profile()
    aid = add_account(pid)
    return pid, slug, aid


def preview(
    pid: int, aid: int, content: bytes, name: str = "history.csv", **kw
) -> imports.ImportPreview:
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        return imports.preview(
            s, profile, imports.ImportRequest(ImportFile(name, content), aid, **kw)
        )


def count(model) -> int:
    with get_session() as s:
        return s.exec(select(func.count()).select_from(model)).one()


def test_preview_is_read_only_and_reports_the_plan(setup):
    pid, _slug, aid = setup
    p = preview(pid, aid, canonical_csv())
    assert p.can_commit and p.importer_id == "finanse"
    assert (p.plan.new_count, p.plan.duplicate_count, len(p.plan.positions)) == (5, 0, 3)
    assert [i.symbol for i in p.plan.new_instruments] == ["ABC", "WRLD", "XMPL"]
    assert any("source 'examplebroker'" in n.message for n in p.notes)  # account belongs to dif
    assert p.reconciliation is not None and p.reconciliation.is_clean
    assert count(InvTransaction) == count(InvInstrument) == count(InvImportBatch) == 0


def test_commit_archives_then_writes_everything(setup):
    pid, slug, aid = setup
    result = import_file(pid, aid, canonical_csv())
    assert (result.inserted, result.duplicates, result.positions) == (5, 0, 3)
    assert len(result.new_instrument_ids) == 3
    archive = paths.data_dir() / result.archive_path
    assert archive.read_bytes() == canonical_csv()
    assert (
        archive.parent == paths.data_dir() / "imports" / slug
        and archive.stat().st_mode & 0o077 == 0
    )
    with get_session() as s:
        rows = s.exec(select(InvTransaction).order_by(InvTransaction.created_at)).all()
        assert [r.external_ref for r in rows] == ["T-1", "T-2", "T-3", "T-4", "T-5"]
        assert len({r.created_at for r in rows}) == 5  # strictly increasing stamps
        assert all(r.import_batch_id == result.batch_id for r in rows)
        assert rows[2].cash_amount == Decimal("-4300.00") and rows[2].fx_rate == Decimal("4.3")
        batch = s.get(InvImportBatch, result.batch_id)
        assert (batch.importer, batch.txn_count, batch.position_count) == ("finanse", 5, 3)
        assert s.exec(select(func.count()).select_from(InvPositionSnapshot)).one() == 3
        xmpl = s.exec(select(InvInstrument).where(InvInstrument.symbol == "XMPL")).one()
        assert (xmpl.currency, xmpl.mic, xmpl.needs_classification) == ("USD", "XNAS", True)
        aliases = s.exec(
            select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id == xmpl.id)
        ).all()
        assert ("yahoo", "XMPL", True) in {(a.namespace, a.value, a.guessed) for a in aliases}
        assert s.get(InvAccountSettings, aid).importer == "finanse"


def test_reimport_is_all_duplicates_and_says_so(setup):
    pid, _slug, aid = setup
    import_file(pid, aid, canonical_csv())
    p = preview(pid, aid, canonical_csv())
    assert (p.plan.new_count, p.plan.duplicate_count) == (0, 5)
    assert any("already imported" in n.message for n in p.notes)
    again = imports.commit(p)
    assert (again.inserted, again.duplicates, again.new_instrument_ids) == (0, 5, [])
    assert count(InvTransaction) == 5 and count(InvInstrument) == 3


def test_commit_is_atomic(setup, monkeypatch):
    pid, _slug, aid = setup
    p = preview(pid, aid, canonical_csv())

    def explode(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(imports.transactions, "upsert_manual_valuation", explode)
    monkeypatch.setattr(imports, "_apply_corrections", explode)
    # fail at the position snapshot step, after instruments and transactions were added
    monkeypatch.setattr(imports, "InvPositionSnapshot", None)
    with pytest.raises(Exception):  # noqa: B017 - any failure must roll everything back
        imports.commit(p)
    assert count(InvTransaction) == count(InvInstrument) == count(InvImportBatch) == 0
    assert count(InvInstrumentAlias) == 0


def test_commit_reuses_an_instrument_created_after_the_preview(setup):
    """Re-resolution: a concurrent import stored XMPL (same ISIN) between preview and commit."""
    pid, _slug, aid = setup
    p = preview(pid, aid, canonical_csv())
    with get_session() as s:
        stored = instruments.insert(
            s,
            Instrument(
                id="x",
                name="Example Corp",
                currency=Currency.USD,
                asset_class=AssetClass.EQUITY,
                symbol="XMPL",
                isin="US0000000001",
                mic="XNAS",
            ),
        )
        stored_id = stored.id
    result = imports.commit(p)
    assert stored_id not in result.new_instrument_ids and len(result.new_instrument_ids) == 2
    with get_session() as s:
        assert s.exec(select(func.count()).where(InvInstrument.isin == "US0000000001")).one() == 1
        xmpl_rows = s.exec(
            select(InvTransaction).where(InvTransaction.instrument_id == stored_id)
        ).all()
        assert sorted(r.external_ref for r in xmpl_rows) == ["T-4", "T-5"]
    # and a later re-import still sees every row as a duplicate (hashes use the final ids)
    assert preview(pid, aid, canonical_csv()).plan.duplicate_count == 5


def test_rename_and_frozen_delisting(setup):
    pid, _slug, aid = setup
    # renames and delistings need the new_* / frozen columns
    header = HEADER + ",new_symbol,new_isin,new_name,frozen"
    rows = [r + ",,,," for r in ROWS] + [
        "1,rename,2026-02-15,,,,ABC,PLABC0000016,,XWAR,,,,,,,,,,,,ABCN,PLABCN000012,ABC New SA,",
        "1,delisting,2026-02-20,,,,XMPL,US0000000001,,XNAS,,,,,,,,,,,,,,,true",
    ]
    content = ("\n".join([header, *rows]) + "\n").encode()
    p = preview(pid, aid, content)
    assert p.can_commit, p.errors
    result = imports.commit(p)
    assert (result.renames, result.status_changes) == (1, 1)
    with get_session() as s:
        rename = s.exec(select(InvInstrumentRename)).one()
        new = s.get(InvInstrument, rename.new_instrument_id)
        assert (new.symbol, rename.profile_id) == ("ABCN", pid)
        xmpl = s.exec(select(InvInstrument).where(InvInstrument.symbol == "XMPL")).one()
        # the delisting is this profile's view; the shared row keeps its market status (F5 R2)
        from finanse.modules.investments.store import instruments as instrument_store

        assert xmpl.status == "active"
        assert instrument_store.load_one(s, xmpl.id, profile_id=pid).status.value == "frozen"
        mv = s.exec(select(InvManualValuation)).one()
        assert (mv.instrument_id, mv.unit_value, mv.currency, mv.profile_id) == (
            xmpl.id,
            0,
            "USD",
            pid,
        )
    # applying the same file again adds no second rename
    assert imports.commit(preview(pid, aid, content)).renames == 0


def test_reconciliation_corrections_apply_once(setup):
    pid, _slug, aid = setup
    p = preview(pid, aid, canonical_csv(xmpl_quantity=25))
    (diff,) = p.reconciliation.mismatches
    assert diff.delta == 5
    planned_xmpl = diff.instrument_id
    result = imports.commit(p, corrections=[planned_xmpl])
    assert result.corrections == 1
    with get_session() as s:
        fix = s.exec(select(InvTransaction).where(InvTransaction.source == "reconciliation")).one()
        assert (fix.type, fix.quantity) == ("adjustment", Decimal(5))
        profile = s.get(profiles.Profile, pid)
        assert imports.reconciliation(s, profile, aid).is_clean
        # the stored snapshot route proposes nothing more, and applying again inserts nothing
        assert imports.apply_reconciliation(s, profile, aid, [fix.instrument_id]) == 0


def test_apply_reconciliation_against_the_stored_snapshot(setup):
    pid, _slug, aid = setup
    import_file(pid, aid, canonical_csv(xmpl_quantity=18))
    with get_session() as s:
        profile = s.get(profiles.Profile, pid)
        report = imports.reconciliation(s, profile, aid)
        (diff,) = report.mismatches
        assert diff.delta == -2
        instrument_id = int(diff.instrument_id)
        assert imports.apply_reconciliation(s, profile, aid, [instrument_id]) == 1
        assert imports.apply_reconciliation(s, profile, aid, [instrument_id]) == 0
        assert imports.reconciliation(s, profile, aid).is_clean
        fix = s.exec(select(InvTransaction).where(InvTransaction.source == "reconciliation")).one()
        assert (fix.type, fix.quantity) == ("transfer_out", Decimal(2))


GENERIC = """\
version: 1
name: "Synthetic broker"
broker_id: genbroker
encoding: utf-8
delimiter: ","
decimal_separator: "."
date_formats: ["yyyy-MM-dd"]
default_currency: PLN
amount_sign: signed
columns:
  trade_date: "date"
  type: "type"
  symbol: "symbol"
  exchange: "exchange"
  quantity: "qty"
  price: "price"
  currency: "ccy"
  cash_amount: "cash"
types:
  "BUY": buy
  "DEP": deposit
"""


def test_generic_csv_mapping_is_remembered(setup):
    pid, _slug, aid = setup
    content = b"date,type,symbol,exchange,qty,price,ccy,cash\n2026-01-05,DEP,,,,,PLN,1000\n2026-01-06,BUY,ABC,XWAR,2,50,PLN,-100\n"
    p = preview(pid, aid, content, name="gen.csv", importer="generic_csv", mapping_yaml=GENERIC)
    assert p.can_commit, p.errors
    assert p.importer_id == "genbroker"
    imports.commit(p)
    with get_session() as s:
        settings = s.get(InvAccountSettings, aid)
        assert settings.importer == "genbroker" and settings.mapping_yaml == GENERIC
    # auto detection now finds the remembered mapping for this account
    again = preview(pid, aid, content, name="gen.csv")
    assert again.importer_id == "genbroker" and again.plan.duplicate_count == 2


def test_a_positions_only_file_keeps_the_remembered_importer(setup):
    """F7 OB4: a positions-only (or corporate-action-only) canonical file must not replace the
    account's export importer and mapping; a file with transactions still does."""
    from invp_support import position_rows

    pid, _slug, aid = setup
    content = b"date,type,symbol,exchange,qty,price,ccy,cash\n2026-01-05,DEP,,,,,PLN,1000\n2026-01-06,BUY,ABC,XWAR,2,50,PLN,-100\n"
    imports.commit(
        preview(pid, aid, content, name="gen.csv", importer="generic_csv", mapping_yaml=GENERIC)
    )
    snapshot = ("\n".join([HEADER, *position_rows()[:1]]) + "\n").encode()
    p = preview(pid, aid, snapshot, name="positions.csv")
    assert p.importer_id == "finanse" and not p.plan.rows and p.plan.positions
    imports.commit(p, corrections=())
    with get_session() as s:
        settings = s.get(InvAccountSettings, aid)
        assert settings.importer == "genbroker" and settings.mapping_yaml == GENERIC
    imports.commit(preview(pid, aid, canonical_csv(positions=False)))
    with get_session() as s:
        assert s.get(InvAccountSettings, aid).importer == "finanse"


def test_errors_are_reported_not_raised(setup):
    pid, _slug, aid = setup
    p = preview(pid, aid, b"not,an,export\n1,2,3\n", name="x.csv")
    assert not p.can_commit and p.errors[0].kind == "file_format"
    with pytest.raises(imports.ImportFailure):
        imports.commit(p)
    bad = canonical_csv(extra=["1,txn,2026-01-08,,buy,T-7,,,,,1,10,PLN,10,,,-10,,,,"])
    assert not preview(pid, aid, bad).can_commit
    with pytest.raises(imports.AccountNotFound):
        preview(pid, 9999, canonical_csv())
    other_pid, _ = make_profile("Ktoś")
    with pytest.raises(imports.AccountNotFound):
        preview(other_pid, aid, canonical_csv())  # another profile's account
