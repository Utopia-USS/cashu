"""Merging two instruments that are the same security (store.instrument_merge and the
``cashu invest instruments merge`` CLI): every reference moves to the target, collisions keep the
target's row, the source is deleted; different ISINs or currencies are refused. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import sqlite3
from decimal import Decimal

import pytest
from invp_support import make_profile
from sqlmodel import select
from typer.testing import CliRunner

from cashu.core.db import get_session
from cashu.modules.investments.models import (
    InvAlert,
    InvInstrument,
    InvInstrumentAlias,
    InvPriceBar,
    InvProfileInstrument,
    InvResearchNote,
    InvThesis,
    InvWatchlistItem,
)
from cashu.modules.investments.store import instrument_merge

ISIN = "US0000000001"


def _instrument(
    s,
    name: str,
    *,
    isin: str | None = None,
    symbol: str | None = None,
    currency: str = "USD",
    asset_class: str = "equity",
) -> int:
    row = InvInstrument(
        name=name,
        currency=currency,
        asset_class=asset_class,
        symbol=symbol,
        isin=isin,
        valuation_mode="market",
    )
    s.add(row)
    s.flush()
    return row.id


@pytest.fixture
def pair(db_engine):
    """Profile with an ISIN-only stub (source) and a ticker instrument (target) of one company."""
    profile_id, _ = make_profile("Inwestor")
    with get_session() as s:
        source = _instrument(s, "Przyklad Corp", isin=ISIN, asset_class="other")
        target = _instrument(s, "Przyklad Corp", symbol="XMPL")
        s.add(InvInstrumentAlias(instrument_id=source, namespace="isin", value=ISIN))
        s.add(InvInstrumentAlias(instrument_id=target, namespace="yahoo", value="XMPL"))
        s.add(
            InvWatchlistItem(
                profile_id=profile_id,
                instrument_id=source,
                note="powod z ISIN",
                tags=["a"],
                removed_at=dt.datetime(2026, 10, 1, tzinfo=dt.UTC),
            )
        )
        s.add(InvWatchlistItem(profile_id=profile_id, instrument_id=target, note=None, tags=["b"]))
        s.add(
            InvThesis(
                profile_id=profile_id,
                instrument_id=source,
                entry_type="sentiment_correction",
                thesis="Stara teza",
            )
        )
        s.add(
            InvThesis(
                profile_id=profile_id,
                instrument_id=target,
                entry_type="sentiment_correction",
                thesis="Nowa teza",
            )
        )
        s.add(
            InvResearchNote(
                profile_id=profile_id,
                instrument_id=source,
                kind="news",
                title="Notatka",
                summary="Fakt.",
                sources=[{"url": "https://x.example"}],
                expires_at=dt.datetime(2026, 11, 1, tzinfo=dt.UTC),
            )
        )
        s.add(
            InvAlert(
                profile_id=profile_id,
                instrument_id=source,
                scope="instrument",
                kind="price_above",
                title="Alert",
            )
        )
        for inst, day, close in ((source, 1, "10"), (source, 2, "11"), (target, 2, "12")):
            s.add(
                InvPriceBar(
                    instrument_id=inst,
                    date=dt.date(2026, 10, day),
                    close=Decimal(close),
                    source="test",
                    fetched_at=dt.datetime(2026, 10, 3, tzinfo=dt.UTC),
                )
            )
        s.add(
            InvProfileInstrument(
                profile_id=profile_id, instrument_id=source, asset_class="other", name="Moja nazwa"
            )
        )
        s.add(InvProfileInstrument(profile_id=profile_id, instrument_id=target, segment="software"))
    return profile_id, source, target


def test_merge_moves_everything_and_deletes_the_source(pair):
    profile_id, source, target = pair
    with get_session() as s:
        report = instrument_merge.merge_instruments(s, source, target)
    assert report.moved["inv_theses.instrument_id"] == 1
    assert report.moved["research_notes.instrument_id"] == 1
    assert report.moved["alerts.instrument_id"] == 1
    assert report.dropped == {
        "watchlist_items": 1,
        "inv_profile_instruments": 1,
        "inv_price_bars": 1,
    }
    with get_session() as s:
        assert s.get(InvInstrument, source) is None
        assert s.get(InvInstrument, target).isin == ISIN
        aliases = {
            (a.namespace, a.value)
            for a in s.exec(
                select(InvInstrumentAlias).where(InvInstrumentAlias.instrument_id == target)
            )
        }
        assert aliases == {("isin", ISIN), ("yahoo", "XMPL")}
        theses = s.exec(select(InvThesis).where(InvThesis.instrument_id == target)).all()
        assert sorted(t.thesis for t in theses) == ["Nowa teza", "Stara teza"]
        items = s.exec(
            select(InvWatchlistItem).where(InvWatchlistItem.profile_id == profile_id)
        ).all()
        assert len(items) == 1
        assert items[0].instrument_id == target
        assert items[0].note == "powod z ISIN"  # target had none
        assert items[0].tags == ["b", "a"]
        assert items[0].removed_at is None  # the target's entry was active and stays so
        bars = {
            b.date.day: b.close
            for b in s.exec(select(InvPriceBar).where(InvPriceBar.instrument_id == target))
        }
        assert bars == {1: Decimal(10), 2: Decimal(12)}  # target wins on the shared day
        override = s.exec(
            select(InvProfileInstrument).where(InvProfileInstrument.profile_id == profile_id)
        ).one()
        assert override.instrument_id == target
        assert override.asset_class is None and override.segment == "software"


def test_dry_run_writes_nothing(pair):
    _, source, target = pair
    with get_session() as s:
        report = instrument_merge.merge_instruments(s, source, target, dry_run=True)
    assert report.dry_run and report.moved
    with get_session() as s:
        assert s.get(InvInstrument, source) is not None
        assert s.get(InvInstrument, target).isin is None


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [({"isin": "US0000000002"}, "Different ISINs"), ({"currency": "EUR"}, "Different currencies")],
)
def test_different_securities_are_refused(db_engine, kwargs, message):
    with get_session() as s:
        source = _instrument(s, "A", isin=ISIN)
        target = _instrument(s, "B", symbol="B", **kwargs)
    with get_session() as s, pytest.raises(instrument_merge.MergeError, match=message):
        instrument_merge.merge_instruments(s, source, target)


def test_same_or_missing_instrument_is_refused(db_engine):
    with get_session() as s:
        only = _instrument(s, "A", isin=ISIN)
    with get_session() as s:
        with pytest.raises(instrument_merge.MergeError, match="same instrument"):
            instrument_merge.merge_instruments(s, only, only)
        with pytest.raises(instrument_merge.MergeError, match="No instrument"):
            instrument_merge.merge_instruments(s, only, only + 999)


def test_cli_merges_and_backs_up(pair, tmp_path):
    from cashu.cli import app

    _, source, target = pair
    runner = CliRunner()
    dry = runner.invoke(
        app, ["invest", "instruments", "merge", str(source), str(target), "--dry-run"]
    )
    assert dry.exit_code == 0, dry.output
    assert "Would merge" in dry.output
    result = runner.invoke(app, ["invest", "instruments", "merge", str(source), str(target)])
    assert result.exit_code == 0, result.output
    assert "Merged" in result.output and "Backup:" in result.output
    backup = result.output.split("Backup:")[1].split()[0]
    with sqlite3.connect(backup) as con:  # a copy of the live DB, before the merge
        assert (
            con.execute("SELECT COUNT(*) FROM inv_instruments WHERE id = ?", (source,)).fetchone()[
                0
            ]
            == 1
        )
    with get_session() as s:
        assert s.get(InvInstrument, source) is None
    refused = runner.invoke(app, ["invest", "instruments", "merge", str(source), str(target)])
    assert refused.exit_code == 1


def _rename(s, profile_id: int, old: int, new: int, day: int = 5):
    from cashu.modules.investments.models import InvInstrumentRename

    s.add(
        InvInstrumentRename(
            profile_id=profile_id,
            date=dt.date(2026, 3, day),
            old_instrument_id=old,
            new_instrument_id=new,
        )
    )


def test_renames_between_or_duplicating_the_pair_are_dropped(db_engine):
    from cashu.modules.investments.models import InvInstrumentRename

    profile_id, _ = make_profile("Inwestor")
    with get_session() as s:
        source = _instrument(s, "A", isin=ISIN)
        target = _instrument(s, "A", symbol="A")
        other = _instrument(s, "Nastepca", symbol="N")
        _rename(s, profile_id, source, target)  # becomes X -> X
        _rename(s, profile_id, target, source)  # becomes X -> X too
        _rename(s, profile_id, source, other)  # duplicates the next one after the merge
        _rename(s, profile_id, target, other)
        _rename(s, profile_id, other, source, day=6)  # moves
    with get_session() as s:
        report = instrument_merge.merge_instruments(s, source, target)
    assert report.dropped["inv_instrument_renames"] == 3
    with get_session() as s:
        rows = {
            (r.old_instrument_id, r.new_instrument_id) for r in s.exec(select(InvInstrumentRename))
        }
    assert rows == {(target, other), (other, target)}


def test_signal_keys_follow_the_target_and_duplicates_are_resolved(db_engine):
    from cashu.modules.investments.models import InvSignal

    profile_id, _ = make_profile("Inwestor")

    def signal(s, inst: int, key: str, status: str = "active") -> None:
        s.add(
            InvSignal(
                profile_id=profile_id,
                rule_id="r",
                kind="k",
                dedup_key=key,
                severity="info",
                status=status,
                message="m",
                instrument_id=inst,
            )
        )

    with get_session() as s:
        source = _instrument(s, "A", isin=ISIN)
        target = _instrument(s, "A", symbol="A")
        signal(s, source, f"plan:no_thesis|i:{source}")  # unique: just renamed
        signal(s, source, f"rule|i:{source}")  # the target already has it open: resolved
        signal(s, target, f"rule|i:{target}")
        signal(s, source, f"rule|i:{source}1", status="resolved")  # another id's prefix: untouched
    with get_session() as s:
        instrument_merge.merge_instruments(s, source, target)
    with get_session() as s:
        rows = {(r.dedup_key, r.status) for r in s.exec(select(InvSignal))}
        assert all(r.instrument_id == target for r in s.exec(select(InvSignal)))
    assert rows == {
        (f"plan:no_thesis|i:{target}", "active"),
        (f"rule|i:{target}", "resolved"),
        (f"rule|i:{target}", "active"),
        (f"rule|i:{source}1", "resolved"),
    }


def test_owner_annotations_move_and_the_owner_segment_wins(db_engine):
    profile_id, _ = make_profile("Inwestor")
    with get_session() as s:
        source = _instrument(s, "A", isin=ISIN)
        target = _instrument(s, "A", symbol="A")
        s.add(
            InvProfileInstrument(
                profile_id=profile_id,
                instrument_id=source,
                plan="buy",
                plan_reason="powod",
                segment="gold",
                segment_by="owner",
                asset_class="other",
                tags=["x"],
            )
        )
        s.add(
            InvProfileInstrument(
                profile_id=profile_id,
                instrument_id=target,
                segment="software",
                segment_by="agent",
                asset_class="equity",
            )
        )
    with get_session() as s:
        report = instrument_merge.merge_instruments(s, source, target)
    assert any("asset_class" in n for n in report.notes)  # the dropped class is reported
    with get_session() as s:
        row = s.exec(select(InvProfileInstrument)).one()
    assert (row.instrument_id, row.plan, row.plan_reason) == (target, "buy", "powod")
    assert (row.segment, row.segment_by, row.asset_class, row.tags) == (
        "gold",
        "owner",
        "equity",
        ["x"],
    )
