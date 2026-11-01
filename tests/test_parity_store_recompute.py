"""Derived oracle reads of a linked synthetic copy use normal capture and leave no writes."""

from __future__ import annotations

import datetime as dt
import os
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from sqlmodel import Session, select

HERE = Path(__file__).resolve().parents[1] / "parity" / "python"
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import canon
from checks import Ctx
from checks.store import _recompute_derived

from cashu.core import profiles, sync_outbox
from cashu.core.db import get_session
from cashu.core.models import Account, Profile, Source
from cashu.core.sync_models import SyncOutbox
from cashu.modules.budget import service
from cashu.modules.budget.models import Transaction


@pytest.fixture
def linked(db_engine, monkeypatch):
    monkeypatch.delenv("CASHU_SYNC", raising=False)
    with get_session() as session:
        profile = profiles.create_profile(session, name="Oracle synthetic", modules_=["budget"])
        pid = profile.id
        accounts = [
            Account(profile_id=pid, bank="mbank", name=f"Synthetic {i}", iban=f"PL{i:026d}")
            for i in (1, 2)
        ]
        session.add_all(accounts)
        session.flush()
        for i, amount in enumerate(("-25", "25")):
            session.add(
                Transaction(
                    account_id=accounts[i].id,
                    booking_date=dt.date(2026, 1, 2),
                    amount=Decimal(amount),
                    counterparty_iban=accounts[1 - i].iban,
                    source=Source.CSV,
                    dedup_hash=f"synthetic-{i}",
                    is_internal_transfer=True,
                    transfer_group_id="synthetic-old-group",
                )
            )
        session.flush()
        sync_outbox.link_vault(session, pid, "0123456789abcdef0123456789abcdef")
    return pid


def snapshot(engine):
    with Session(engine) as session:
        return (
            [
                row.model_dump()
                for row in session.exec(select(Transaction).order_by(Transaction.id))
            ],
            [row.model_dump() for row in session.exec(select(SyncOutbox).order_by(SyncOutbox.id))],
        )


@pytest.mark.parametrize("previous", [None, "0", "1"])
@pytest.mark.parametrize("fail", [False, True])
def test_linked_recompute_is_rolled_back_and_restores_environment(
    db_engine, linked, monkeypatch, previous, fail
):
    if previous is None:
        monkeypatch.delenv("CASHU_SYNC", raising=False)
    else:
        monkeypatch.setenv("CASHU_SYNC", previous)
    before = snapshot(db_engine)
    original = service.categorize_all

    def categorize_and_verify_capture(session, *args, **kwargs):
        original(session, *args, **kwargs)
        # A normal claimed-field write proves capture stayed active inside the rollback scope.
        row = session.get(Transaction, before[0][0]["id"])
        row.description = "synthetic temporary capture"
        session.add(row)
        session.flush()
        assert any(
            item["fields"].get("description") == "synthetic temporary capture"
            for item in sync_outbox.rows_of(session)
        )
        if fail:
            raise RuntimeError("synthetic oracle failure")

    monkeypatch.setattr(service, "categorize_all", categorize_and_verify_capture)
    with Session(db_engine) as caller:
        profile = caller.get(Profile, linked)
        ctx = Ctx("demo", dt.date(2026, 1, 2), caller, canon.IdMap(caller), [profile])
        rows = [dict(row) for row in before[0]]
        transaction = caller.get_transaction()
        info = dict(caller.info)
        if fail:
            with pytest.raises(RuntimeError, match="synthetic oracle failure"):
                _recompute_derived(ctx, rows)
        else:
            _recompute_derived(ctx, rows)
            assert all(row["is_internal_transfer"] for row in rows)
            assert {row["transfer_group_id"] for row in rows} == {
                ctx.ids.key("transactions", rows[0]["id"])
            }
            assert all(row["category_source"] == "transfer" for row in rows)
        assert caller.get_transaction() is transaction
        assert caller.info == info
        assert os.environ.get("CASHU_SYNC") == previous
        assert snapshot(db_engine) == before

    # The ordinary linked-write guard remains active outside the oracle scope.
    monkeypatch.delenv("CASHU_SYNC", raising=False)
    with Session(db_engine) as session:
        row = session.get(Transaction, before[0][0]["id"])
        row.description = "synthetic forbidden write"
        with pytest.raises(sync_outbox.SyncCaptureError, match="CASHU_SYNC=1"):
            session.flush()
    assert snapshot(db_engine) == before
