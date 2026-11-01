"""Inbound applier (S31b, ``core/sync_apply.py``): events of other devices applied through the services,
idempotent by eid, never echoed into the outbox, LWW-F by HLC against local and inbound writes,
allow-list, one vault per run, unknown gids parked and retried. Synthetic data only."""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
from decimal import Decimal

import keyring
import pytest
from sqlalchemy import func
from sqlmodel import select

from cashu.core import accounts, profiles, reviews, sync_apply, sync_keys, sync_outbox
from cashu.core.agent_models import Review
from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.core.sync_models import SyncClock, SyncId, SyncInbound, SyncOutbox
from cashu.modules.budget.categorize.rules import upsert_rule
from cashu.modules.budget.models import CategoryRule, Transaction
from cashu.modules.investments.models import (
    InvAlert,
    InvDecision,
    InvDecisionSignal,
    InvInstrument,
    InvResearchNote,
    InvSignal,
)
from cashu.modules.investments.service import alerts
from cashu.modules.investments.store import journal

TEST_SALT = bytes(range(32))
VAULT = "0123456789abcdef0123456789abcdef"
OTHER_VAULT = "fedcba9876543210fedcba9876543210"
DEVICE = "3f9a2c8e1d7b4a6050c3e9f12d8b7a64"
DEVICE_B = "4f9a2c8e1d7b4a6050c3e9f12d8b7a64"
SECRET_NOTE = "notatka-ktorej-nie-ma-w-logach"
_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _b36(n: int, width: int) -> str:
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return out.rjust(width, "0")


def now_ms() -> int:
    return int(time.time() * 1000)


def event(
    type_: str,
    gid: str,
    data: dict,
    *,
    ms: int | None = None,
    counter: int = 0,
    device: str = DEVICE,
    vault: str = VAULT,
    eid: str | None = None,
    cause: str | None = None,
) -> dict:
    ms = now_ms() + 60_000 if ms is None else ms  # one minute ahead: after the setup's writes
    at = dt.datetime.fromtimestamp(ms / 1000, dt.UTC)
    env = {
        "eid": eid or sync_keys.mint_ulid(ms),
        "vault": vault,
        "device": device,
        "hlc": f"{_b36(ms, 9)}-{_b36(counter, 4)}-{device}",
        "at": at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z",
        "type": type_,
        "v": 1,
        "gid": gid,
        "data": data,
    }
    if cause:
        env["cause"] = cause
    return env


@pytest.fixture
def world(db_engine, monkeypatch):
    """A linked profile (budget + investments) with one account, transaction, instrument, signal, alert
    and research note, every row known by gid; the setup's outbox rows shipped (acked)."""
    monkeypatch.setenv("CASHU_SYNC", "1")
    sync_keys.forget_cached_salts()
    keyring.set_password("cashu", f"cashu.vault.{VAULT}.gidsalt", TEST_SALT.hex())
    with get_session() as s:
        pid = profiles.create_profile(s, name="Inbound", modules_=["budget", "investments"]).id
        sync_outbox.link_vault(s, pid, VAULT)
    with get_session() as s:
        acc = accounts.get_or_create_account(
            s, bank="mbank", iban="99114000000000000000000031", name="Konto", profile_id=pid
        )
        txn = Transaction(
            account_id=acc.id, booking_date=dt.date(2026, 3, 2), amount=Decimal("-9.99"), currency="PLN",
            counterparty_name="SKLEP TESTOWY", source="csv", dedup_hash="test-in-1", occurrence=0,
            category="groceries", category_source="rule",
        )
        inst = InvInstrument(name="Test SA", currency="PLN", asset_class="stock", valuation_mode="market", tags=[])
        s.add_all([txn, inst])
        s.flush()
        sig = InvSignal(
            profile_id=pid, rule_id="drawdown", kind="drawdown", dedup_key=f"drawdown|i:{inst.id}",
            severity="info", status="active", message="Spadek testowy", instrument_id=inst.id, payload={},
        )
        alert = InvAlert(
            profile_id=pid, instrument_id=inst.id, scope="instrument", kind="price_below",
            params={"price": "10"}, polarity="negative", severity="info", title="Alert testowy",
        )
        note = InvResearchNote(
            profile_id=pid, instrument_id=inst.id, kind="news", title="Notatka", summary="Streszczenie",
            sources=[{"title": "t", "url": "https://example.com"}],
            expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=30),
        )
        s.add_all([sig, alert, note])
        s.flush()
        rows = {
            "accounts": acc.id, "transactions": txn.id, "inv_instruments": inst.id,
            "inv_signals": sig.id, "alerts": alert.id, "research_notes": note.id,
        }
    gids = {}
    with get_session() as s:
        for table, local_id in rows.items():
            mapped = s.exec(
                select(SyncId).where(SyncId.profile_id == pid, SyncId.table_name == table, SyncId.local_id == str(local_id))
            ).first()
            if mapped is None:  # shipper-computed gid (accounts, transactions, instruments): seed it
                mapped = SyncId(profile_id=pid, table_name=table, local_id=str(local_id), gid=sync_keys.mint_ulid(), source="genesis")
                s.add(mapped)
            gids[table] = mapped.gid
    ship()
    yield {"pid": pid, "ids": rows, "gids": gids}
    sync_keys.forget_cached_salts()


def ship() -> None:
    """The shipper acked everything pending."""
    with get_session() as s:
        top = s.exec(select(func.max(SyncOutbox.id))).one()
        if top:
            sync_outbox.ack(s, top)


def apply(*events, pid: int, **kw) -> dict:
    return sync_apply.apply_events(list(events), profile_id=pid, **kw)


def only(summary: dict, status: str, n: int = 1) -> bool:
    return summary[status] == n and sum(summary[k] for k in sync_apply.STATUSES) == n


def table_counts() -> dict:
    from sqlmodel import SQLModel

    with get_session() as s:
        conn = s.connection()
        return {
            name: conn.execute(select(func.count()).select_from(t)).scalar()
            for name, t in SQLModel.metadata.tables.items()
        }


def alert_row(world) -> InvAlert:
    with get_session() as s:
        return s.get(InvAlert, world["ids"]["alerts"])


def inbound_row(eid: str) -> SyncInbound | None:
    with get_session() as s:
        return s.get(SyncInbound, eid)


# --------------------------------------------------------------------------- #
# Idempotency and echo
# --------------------------------------------------------------------------- #


def test_apply_twice_is_apply_once(world):
    pid, g = world["pid"], world["gids"]
    batch = [
        event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}),
        event("decision.recorded", sync_keys.mint_ulid(), {
            "signals": [g["inv_signals"]], "instrument": g["inv_instruments"], "account": None,
            "action": "held", "quantity": None, "price": None, "currency": None, "reason": None,
        }),
        event("review.done", sync_keys.mint_ulid(), {"module": "investments", "notes": None, "stats": {}}),
    ]
    first = apply(*batch, pid=pid)
    assert only(first, "applied", 3)
    before = table_counts()
    with get_session() as s:
        decisions = [(d.id, d.action) for d in s.exec(select(InvDecision)).all()]
    second = apply(*batch, pid=pid)
    assert only(second, "duplicate", 3)
    assert table_counts() == before
    with get_session() as s:
        assert [(d.id, d.action) for d in s.exec(select(InvDecision)).all()] == decisions
    assert alert_row(world).status == "muted"


def test_inbound_writes_are_not_echoed_but_a_later_local_edit_is(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        mark = s.exec(select(func.max(SyncOutbox.id))).one() or 0
    decision_gid = sync_keys.mint_ulid()
    summary = apply(
        event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}),
        event("decision.recorded", decision_gid, {
            "signals": [g["inv_signals"]], "instrument": None, "account": None, "action": "ignored",
            "quantity": None, "price": None, "currency": None, "reason": None,
        }),
        event("txn.categorySet", g["transactions"], {"category": "fuel", "source": "manual_txn"}),
        pid=pid,
    )
    assert only(summary, "applied", 3)
    with get_session() as s:
        assert sync_outbox.pending(s) == []  # nothing for the shipper: no echo
        new = [r for r in sync_outbox.rows_of(s) if r["id"] > mark]
    assert new and all(r["origin"] == "inbound" and r["acked_at"] is not None for r in new)
    created = [r for r in new if r["table_name"] == "inv_decisions" and r["op"] == "insert"]
    assert [r["gid"] for r in created] == [decision_gid]  # the event's gid, not a fresh ULID
    with get_session() as s:
        decision = s.exec(select(InvDecision)).one()
        mapped = s.exec(select(SyncId).where(SyncId.table_name == "inv_decisions")).one()
        assert (mapped.local_id, mapped.gid, mapped.source) == (str(decision.id), decision_gid, "inbound")
    # a later local edit of the same rows is captured and shipped under the same gids
    with get_session() as s:
        alerts.update(s, s.get(Profile, pid), world["ids"]["alerts"], {"title": "Lokalny tytul"})
    with get_session() as s:
        journal.undo_decision(s, pid, s.get(InvDecision, decision.id))
    with get_session() as s:
        local = sync_outbox.pending(s)
    assert {(r["table_name"], r["op"], r["gid"]) for r in local} >= {
        ("alerts", "update", g["alerts"]),
        ("inv_decisions", "undo", decision_gid),
    }
    assert all(r["origin"] == "local" for r in local)


# --------------------------------------------------------------------------- #
# Each allowed type
# --------------------------------------------------------------------------- #


def test_txn_category_set_is_a_manual_claim(world):
    pid, g = world["pid"], world["gids"]
    assert only(apply(event("txn.categorySet", g["transactions"], {"category": "fuel", "source": "manual_txn"}), pid=pid), "applied")
    with get_session() as s:
        t = s.get(Transaction, world["ids"]["transactions"])
        assert (t.category, t.category_source) == ("fuel", "manual_txn")
    llm = apply(event("txn.categorySet", g["transactions"], {"category": "fuel", "source": "llm_full"}), pid=pid)
    assert only(llm, "rejected") and llm["reasons"] == {"rejected:unsupported-source": 1}


def test_category_rule_set_pins_the_merchant(world):
    pid = world["pid"]
    gid = sync_keys.det_gid(sync_keys.Salt(TEST_SALT), "category_rules", ["SKLEP TESTOWY"])
    data = {"merchantKey": "SKLEP TESTOWY", "category": "restaurants", "source": "manual", "locked": True}
    ms = now_ms() + 120_000
    assert only(apply(event("categoryRule.set", gid, data, ms=ms), pid=pid), "applied")
    with get_session() as s:
        rule = s.exec(select(CategoryRule).where(CategoryRule.profile_id == pid)).one()
        assert (rule.merchant_key, rule.category, rule.source, rule.locked) == ("SKLEP TESTOWY", "restaurants", "manual", True)
        # S31a: a rule the event creates carries the event's domain time, as the TS fold does
        expected = dt.datetime.fromtimestamp(ms / 1000, dt.UTC).replace(tzinfo=None)
        assert rule.created_at.replace(tzinfo=None) == expected
        t = s.get(Transaction, world["ids"]["transactions"])
        assert (t.category, t.category_source) == ("restaurants", "manual")  # re-applied to its rows
        mapped = s.exec(select(SyncId).where(SyncId.table_name == "category_rules")).one()
        assert (mapped.local_id, mapped.gid) == (str(rule.id), gid)
    # an LLM rule never replaces the locked one (GUARD)
    llm = {"merchantKey": "SKLEP TESTOWY", "category": "fuel", "source": "llm", "locked": False}
    out = apply(event("categoryRule.set", gid, llm), pid=pid)
    assert only(out, "lost") and out["reasons"] == {"lost:guard": 1}


def test_category_rule_set_checks_its_gid_and_needs_the_salt(world, monkeypatch):
    pid = world["pid"]
    data = {"merchantKey": "SKLEP TESTOWY", "category": "fuel", "source": "manual", "locked": True}
    wrong = sync_keys.det_gid(sync_keys.Salt(TEST_SALT), "category_rules", ["INNY SKLEP"])
    out = apply(event("categoryRule.set", wrong, data), pid=pid)
    assert only(out, "rejected") and out["reasons"] == {"rejected:invalid-gid": 1}
    keyring.delete_password("cashu", f"cashu.vault.{VAULT}.gidsalt")
    sync_keys.forget_cached_salts()
    right = sync_keys.det_gid(sync_keys.Salt(TEST_SALT), "category_rules", ["SKLEP TESTOWY"])
    out = apply(event("categoryRule.set", right, data), pid=pid)
    assert only(out, "parked") and out["reasons"] == {"parked:no-salt": 1}
    keyring.set_password("cashu", f"cashu.vault.{VAULT}.gidsalt", TEST_SALT.hex())
    sync_keys.forget_cached_salts()
    out = apply(pid=pid)
    assert out["retried"] == 1 and only(out, "applied")


def test_alert_updated_and_status_set(world):
    pid, g = world["pid"], world["gids"]
    out = apply(event("alert.updated", g["alerts"], {"title": "Nowy tytul", "severity": "action"}), pid=pid)
    assert only(out, "applied")
    row = alert_row(world)
    assert (row.title, row.severity) == ("Nowy tytul", "action")
    until_ms = now_ms() + 3 * 86_400_000
    until = dt.datetime.fromtimestamp(until_ms / 1000, dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert only(apply(event("alert.statusSet", g["alerts"], {"status": "snoozed", "snoozedUntil": until}, ms=now_ms() + 120_000), pid=pid), "applied")
    row = alert_row(world)
    assert row.status == "snoozed" and row.snoozed_until is not None
    assert only(apply(event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}, ms=now_ms() + 180_000), pid=pid), "applied")
    row = alert_row(world)
    assert (row.status, row.snoozed_until) == ("muted", None)
    bad = apply(event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": until}), pid=pid)
    assert only(bad, "rejected") and bad["reasons"] == {"rejected:bad-payload": 1}


def test_signal_snoozed(world):
    pid, g = world["pid"], world["gids"]
    until = (dt.datetime.now(dt.UTC) + dt.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert only(apply(event("signal.snoozed", g["inv_signals"], {"until": until}), pid=pid), "applied")
    with get_session() as s:
        assert s.get(InvSignal, world["ids"]["inv_signals"]).snoozed_until is not None
    assert only(apply(event("signal.snoozed", g["inv_signals"], {"until": None}, ms=now_ms() + 120_000), pid=pid), "applied")
    with get_session() as s:
        assert s.get(InvSignal, world["ids"]["inv_signals"]).snoozed_until is None


def test_decision_recorded_acknowledges_its_signal(world):
    pid, g = world["pid"], world["gids"]
    gid = sync_keys.mint_ulid()
    data = {
        "signals": [g["inv_signals"]], "instrument": g["inv_instruments"], "account": g["accounts"],
        "action": "bought", "quantity": "2", "price": "10.50", "currency": "PLN", "reason": None,
    }
    ms = now_ms() + 60_000
    assert only(apply(event("decision.recorded", gid, data, ms=ms), pid=pid), "applied")
    with get_session() as s:
        d = s.exec(select(InvDecision)).one()
        assert (d.action, d.quantity, d.price, d.instrument_id, d.account_id) == (
            "bought", Decimal(2), Decimal("10.50"), world["ids"]["inv_instruments"], world["ids"]["accounts"],
        )
        created = d.created_at if d.created_at.tzinfo else d.created_at.replace(tzinfo=dt.UTC)
        assert abs(created - dt.datetime.fromtimestamp(ms / 1000, dt.UTC)) < dt.timedelta(milliseconds=2)  # domain time
        assert [link.signal_id for link in s.exec(select(InvDecisionSignal)).all()] == [world["ids"]["inv_signals"]]
        assert s.get(InvSignal, world["ids"]["inv_signals"]).status == "acknowledged"
    # the same decision gid again under a new eid (e.g. re-sent): no second row
    assert only(apply(event("decision.recorded", gid, data), pid=pid), "applied")
    with get_session() as s:
        assert s.exec(select(func.count()).select_from(InvDecision)).one() == 1


def test_review_done(world):
    pid = world["pid"]
    gid = sync_keys.mint_ulid()
    assert only(apply(event("review.done", gid, {"module": "investments", "notes": "Tydzien ok", "stats": {"cards": 3}}), pid=pid), "applied")
    with get_session() as s:
        row = s.exec(select(Review)).one()
        assert (row.module, row.notes, row.stats) == ("investments", "Tydzien ok", {"cards": 3})
        assert s.exec(select(SyncId.gid).where(SyncId.table_name == "reviews")).one() == gid
        reviews.undo(s, pid, row.id)  # a local undo of an inbound review works as for a local one


def test_note_read_and_dismissed(world):
    pid, g = world["pid"], world["gids"]
    assert only(apply(event("note.read", g["research_notes"], {}), pid=pid), "applied")
    with get_session() as s:
        assert s.get(InvResearchNote, world["ids"]["research_notes"]).read_at is not None
    out = apply(event("note.dismissed", g["research_notes"], {"cooldownUntil": None}, ms=now_ms() + 120_000), pid=pid)
    assert only(out, "applied")
    with get_session() as s:
        assert s.get(InvResearchNote, world["ids"]["research_notes"]).dismissed_at is not None


def test_owner_signal_close_rides_with_its_action(world):
    pid, g = world["pid"], world["gids"]
    mute = event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None})
    close = event("signal.closed", g["inv_signals"], {"status": "resolved", "reason": "mute"}, counter=1, cause=mute["eid"])
    out = sync_apply.apply_events([[mute, close]], profile_id=pid)  # one batch
    assert out["applied"] == 1 and out["covered"] == 1
    rule_close = event("signal.closed", g["inv_signals"], {"status": "resolved", "reason": "warunek ustal"})
    out = apply(rule_close, pid=pid)
    assert only(out, "rejected") and out["reasons"] == {"rejected:disallowed": 1}


# --------------------------------------------------------------------------- #
# Allow-list, vault, envelope
# --------------------------------------------------------------------------- #


def test_a_disallowed_type_is_rejected_and_logged_without_data(world, caplog):
    pid, g = world["pid"], world["gids"]
    ev = event("thesis.updated", sync_keys.mint_ulid(), {"thesis": SECRET_NOTE})
    before = table_counts()
    with caplog.at_level(logging.WARNING, logger="cashu.core.sync_apply"):
        out = apply(ev, pid=pid)
    assert only(out, "rejected") and out["reasons"] == {"rejected:disallowed": 1}
    assert "thesis.updated" in caplog.text and "disallowed" in caplog.text
    assert SECRET_NOTE not in caplog.text and ev["eid"] not in caplog.text and VAULT not in caplog.text
    after = table_counts()
    assert after.pop("sync_inbound") == before.pop("sync_inbound") + 1 and after == before
    row = inbound_row(ev["eid"])
    assert (row.status, row.reason, row.body) == ("rejected", "disallowed", None)  # no data kept
    assert only(apply(ev, pid=pid), "duplicate")
    # a malformed type is logged as a placeholder
    with caplog.at_level(logging.WARNING, logger="cashu.core.sync_apply"):
        out = apply(dict(event("alert.statusSet", g["alerts"], {}), type=SECRET_NOTE), pid=pid)
    assert out["reasons"] == {"rejected:bad-envelope": 1} and SECRET_NOTE not in caplog.text


def test_another_profiles_vault_is_rejected(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        other = profiles.create_profile(s, name="Druga", modules_=["investments"]).id
        sync_outbox.link_vault(s, other, OTHER_VAULT)
    ev = event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}, vault=OTHER_VAULT)
    out = apply(ev, pid=pid)
    assert only(out, "rejected") and out["reasons"] == {"rejected:profile-mismatch": 1}
    assert inbound_row(ev["eid"]) is None and alert_row(world).status == "active"
    # applied to the other profile, the gid means nothing there (sync_ids are per vault): parked
    out = apply(ev, pid=other)
    assert only(out, "parked") and alert_row(world).status == "active"
    with get_session() as s:
        unlinked = profiles.create_profile(s, name="Trzecia", modules_=["investments"]).id
    out = apply(event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}), pid=unlinked)
    assert only(out, "rejected") and out["reasons"] == {"rejected:vault-not-linked": 1}


def test_an_eid_reused_with_another_body_is_rejected(world):
    pid, g = world["pid"], world["gids"]
    ev = event("alert.updated", g["alerts"], {"title": "Pierwszy"})
    assert only(apply(ev, pid=pid), "applied")
    forged = dict(ev, data={"title": "Drugi"})
    out = apply(forged, pid=pid)
    assert only(out, "rejected") and out["reasons"] == {"rejected:eid-reused": 1}
    assert alert_row(world).title == "Pierwszy"


def test_a_bad_envelope_is_rejected(world):
    pid, g = world["pid"], world["gids"]
    good = event("alert.updated", g["alerts"], {"title": "X"})
    for broken in (
        dict(good, hlc=good["hlc"][:15] + DEVICE_B),  # HLC suffix is not the device
        dict(good, eid="not-a-ulid"),
        dict(good, device="0" * 32),
        dict(good, data=[]),
        dict(good, v=True),
        "not an object",
    ):
        out = apply(broken, pid=pid)
        assert only(out, "rejected") and out["reasons"] == {"rejected:bad-envelope": 1}
    assert alert_row(world).title == "Alert testowy"


def test_capture_must_be_on(world, monkeypatch):
    monkeypatch.setenv("CASHU_SYNC", "0")
    with pytest.raises(sync_apply.SyncApplyError):
        apply(pid=world["pid"])


# --------------------------------------------------------------------------- #
# Conflicts (LWW-F by HLC)
# --------------------------------------------------------------------------- #


def test_an_inbound_edit_older_than_a_shipped_local_edit_loses(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        alerts.update(s, s.get(Profile, pid), world["ids"]["alerts"], {"title": "Lokalny"})
    ship()
    older = event("alert.updated", g["alerts"], {"title": "Z telefonu"}, ms=now_ms() - 3_600_000)
    out = apply(older, pid=pid)
    assert only(out, "lost") and out["reasons"] == {"lost:older": 1}
    assert alert_row(world).title == "Lokalny"
    newer = event("alert.updated", g["alerts"], {"title": "Nowszy"}, ms=now_ms() + 60_000)
    assert only(apply(newer, pid=pid), "applied") and alert_row(world).title == "Nowszy"


def local_title(world, title: str) -> None:
    with get_session() as s:
        alerts.update(s, s.get(Profile, world["pid"]), world["ids"]["alerts"], {"title": title})


def ship_with_clocks(world, ms: int, cols=("title",)) -> None:
    """The shipper acked everything pending, the alert's columns stamped at ``ms`` (S31a P-A)."""
    stamp = [f"{_b36(ms, 9)}-0000-{DEVICE_B}", sync_keys.mint_ulid(ms)]
    entry = {
        "profile_id": world["pid"], "table": "alerts", "local_id": str(world["ids"]["alerts"]),
        "clocks": {c: stamp for c in cols},
    }
    with get_session() as s:
        sync_outbox.ack(s, s.exec(select(func.max(SyncOutbox.id))).one(), [entry])


def test_a_shipped_local_edit_competes_with_its_stamp(world):
    """Section 7: the ack's clock decides, not the wall time of the outbox row (``hlc_floor``)."""
    pid, g = world["pid"], world["gids"]
    local_title(world, "Lokalny")
    stamped = now_ms() + 600_000  # the log stamped it later than its outbox wall time
    ship_with_clocks(world, stamped)
    between = event("alert.updated", g["alerts"], {"title": "Starszy"}, ms=stamped - 300_000)
    out = apply(between, pid=pid)  # after the outbox ts, before the stamp: older
    assert only(out, "lost") and out["reasons"] == {"lost:older": 1}
    assert alert_row(world).title == "Lokalny"
    after = event("alert.updated", g["alerts"], {"title": "Nowszy"}, ms=stamped + 1)
    assert only(apply(after, pid=pid), "applied") and alert_row(world).title == "Nowszy"


def test_a_pruned_outbox_row_keeps_its_decision(world):
    pid, g = world["pid"], world["gids"]
    local_title(world, "Lokalny")
    stamped = now_ms() + 600_000
    ship_with_clocks(world, stamped)
    with get_session() as s:
        assert sync_outbox.prune(s) > 0
    out = apply(event("alert.updated", g["alerts"], {"title": "Starszy"}, ms=stamped - 1), pid=pid)
    assert only(out, "lost") and alert_row(world).title == "Lokalny"


def test_a_column_carried_by_two_acks_keeps_the_later_stamp(world):
    pid, g = world["pid"], world["gids"]
    base = now_ms() + 600_000
    local_title(world, "Pierwszy")
    ship_with_clocks(world, base + 2000)
    local_title(world, "Drugi")
    ship_with_clocks(world, base + 1000)  # acked out of order: the clock keeps the later stamp
    with get_session() as s:
        clock = s.get(SyncClock, (pid, "alerts", str(world["ids"]["alerts"]), "title"))
        assert clock.hlc == f"{_b36(base + 2000, 9)}-0000-{DEVICE_B}"
    out = apply(event("alert.updated", g["alerts"], {"title": "Z telefonu"}, ms=base + 1500), pid=pid)
    assert only(out, "lost") and alert_row(world).title == "Drugi"


def test_an_ack_never_moves_an_inbound_clock_back(world):
    pid, g = world["pid"], world["gids"]
    base = now_ms() + 600_000
    assert only(apply(event("alert.updated", g["alerts"], {"title": "Z telefonu"}, ms=base + 2000), pid=pid), "applied")
    ship_with_clocks(world, base)  # an older local stamp of the same column
    out = apply(event("alert.updated", g["alerts"], {"title": "Starszy"}, ms=base + 1000), pid=pid)
    assert only(out, "lost") and alert_row(world).title == "Z telefonu"


def test_lww_is_per_field(world):
    pid, g = world["pid"], world["gids"]
    base = now_ms() + 60_000
    assert only(apply(event("alert.updated", g["alerts"], {"title": "T3"}, ms=base + 3000), pid=pid), "applied")
    middle = event("alert.updated", g["alerts"], {"title": "T2", "severity": "action"}, ms=base + 2000)
    assert only(apply(middle, pid=pid), "applied")  # severity was not written after it
    row = alert_row(world)
    assert (row.title, row.severity) == ("T3", "action")


def test_an_unshipped_local_edit_beats_any_inbound_edit(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        alerts.mute(s, s.get(Profile, pid), world["ids"]["alerts"])
    # still in the outbox: the shipper stamps it after this event, so it sorts later
    out = apply(event("alert.statusSet", g["alerts"], {"status": "active", "snoozedUntil": None}), pid=pid)
    assert only(out, "lost")
    assert alert_row(world).status == "muted"


def test_inbound_edits_order_by_hlc_not_by_arrival(world):
    pid, g = world["pid"], world["gids"]
    base = now_ms() + 60_000
    newer = event("alert.updated", g["alerts"], {"title": "B"}, ms=base, device=DEVICE_B)
    older = event("alert.updated", g["alerts"], {"title": "A"}, ms=base, device=DEVICE)  # same wall, lower device
    assert only(apply(newer, pid=pid), "applied")
    assert only(apply(older, pid=pid), "lost")
    assert alert_row(world).title == "B"
    with get_session() as s:
        clock = s.get(SyncClock, (pid, "alerts", str(world["ids"]["alerts"]), "title"))
        assert (clock.hlc, clock.eid) == (newer["hlc"], newer["eid"])


def test_daily_check_status_does_not_beat_an_owner_mute(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        row = s.get(InvAlert, world["ids"]["alerts"])
        row.status = "triggered"  # the daily check (runtime register, not the owner's)
        s.add(row)
    out = apply(event("alert.statusSet", g["alerts"], {"status": "muted", "snoozedUntil": None}, ms=now_ms() - 60_000), pid=pid)
    assert only(out, "applied") and alert_row(world).status == "muted"


def test_a_manual_claim_beats_a_later_local_llm_claim(world):
    pid, g = world["pid"], world["gids"]
    with get_session() as s:
        t = s.get(Transaction, world["ids"]["transactions"])
        t.category, t.category_source = "fuel", "llm_full"
        s.add(t)
    ship()
    old_manual = event("txn.categorySet", g["transactions"], {"category": "health", "source": "manual_txn"}, ms=now_ms() - 3_600_000)
    assert only(apply(old_manual, pid=pid), "applied")  # GUARD: the LLM claim is a no-op after it
    with get_session() as s:
        t = s.get(Transaction, world["ids"]["transactions"])
        assert (t.category, t.category_source) == ("health", "manual_txn")


def test_a_locked_rule_beats_a_later_local_llm_rule(world):
    pid = world["pid"]
    with get_session() as s:
        upsert_rule(s, "SKLEP TESTOWY", "fuel", source="llm", profile_id=pid)
    ship()
    gid = sync_keys.det_gid(sync_keys.Salt(TEST_SALT), "category_rules", ["SKLEP TESTOWY"])
    data = {"merchantKey": "SKLEP TESTOWY", "category": "groceries", "source": "manual", "locked": True}
    assert only(apply(event("categoryRule.set", gid, data, ms=now_ms() - 3_600_000), pid=pid), "applied")
    with get_session() as s:
        rule = s.exec(select(CategoryRule)).one()
        assert (rule.category, rule.locked) == ("groceries", True)


# --------------------------------------------------------------------------- #
# Parking
# --------------------------------------------------------------------------- #


def test_an_unknown_gid_is_parked_and_retried(world):
    pid = world["pid"]
    with get_session() as s:
        alert = InvAlert(
            profile_id=pid, scope="portfolio", kind="drawdown", params={"pct": "10"},
            polarity="negative", severity="info", title="Nowy alert",
        )
        s.add(alert)
        s.flush()
        alert_id = alert.id
        s.exec(select(SyncId).where(SyncId.table_name == "alerts", SyncId.local_id == str(alert_id))).one()
        # forget the mapping: the phone knows the alert by a gid this device has not learned yet
        s.delete(s.exec(select(SyncId).where(SyncId.table_name == "alerts", SyncId.local_id == str(alert_id))).one())
    ship()
    gid = sync_keys.mint_ulid()
    ev = event("alert.updated", gid, {"title": SECRET_NOTE})
    out = apply(ev, pid=pid)
    assert only(out, "parked") and out["reasons"] == {"parked:unknown-gid": 1}
    assert inbound_row(ev["eid"]).body == ev  # kept for the retry
    assert only(apply(pid=pid), "parked") and apply(pid=pid)["retried"] == 1
    with get_session() as s:
        s.add(SyncId(profile_id=pid, table_name="alerts", local_id=str(alert_id), gid=gid, source="shipper"))
    out = apply(pid=pid)
    assert out["retried"] == 1 and only(out, "applied")
    with get_session() as s:
        assert s.get(InvAlert, alert_id).title == SECRET_NOTE
    row = inbound_row(ev["eid"])
    assert (row.status, row.body) == ("applied", None)
    assert apply(pid=pid)["retried"] == 0


def test_a_caused_event_waits_for_its_cause(world):
    pid, g = world["pid"], world["gids"]
    ms = now_ms() + 60_000
    first = event("review.done", sync_keys.mint_ulid(), {"module": "investments", "notes": None, "stats": {}}, ms=ms)
    ev = event("alert.updated", g["alerts"], {"title": "Po przyczynie"}, ms=ms, counter=1, cause=first["eid"])
    out = apply(ev, pid=pid)  # its cause has not arrived yet
    assert only(out, "parked") and out["reasons"] == {"parked:cause-pending": 1}
    assert alert_row(world).title == "Alert testowy"
    assert only(apply(first, pid=pid), "applied", 2)  # the cause sorts first, then the retry
    assert alert_row(world).title == "Po przyczynie"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def test_cli_apply_reads_json_lines(world):
    from typer.testing import CliRunner

    from cashu.cli import app

    g = world["gids"]
    with get_session() as s:
        slug = s.get(Profile, world["pid"]).slug
    lines = "\n".join([
        json.dumps(event("alert.updated", g["alerts"], {"title": "Z CLI"})),
        json.dumps([event("note.read", g["research_notes"], {})]),
        "{not json",
        "",
    ])
    out = CliRunner().invoke(app, ["--profile", slug, "sync", "apply", "--stdin"], input=lines)
    assert out.exit_code == 0, out.output
    summary = json.loads(out.output.strip().splitlines()[-1])
    assert (summary["applied"], summary["rejected"]) == (2, 1)
    assert summary["reasons"] == {"rejected:bad-json": 1}
    assert "Z CLI" not in out.output
    assert alert_row(world).title == "Z CLI"
    assert CliRunner().invoke(app, ["sync", "apply"]).exit_code == 2
