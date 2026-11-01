#!/usr/bin/env python3
"""Scripted synthetic writes of the bridge harness (S31a spec 9.3 steps 3, 5, 7).

    .venv/bin/python parity/python/bridge_writes.py --dataset lab|demo --phase A|B|C|R|M [--part 1|2|3]

Runs on the CURRENT data dir, which must be a run copy inside ``~/cashu-lab/parity/`` (never a dataset
source): the harness starts it under golden.py ``safe_env`` with ``CASHU_DATA_DIR`` = the run's
``data/``, ``CASHU_SYNC=1`` (required here), the lab keyring and ``CASHU_PARITY_CLOCK`` (the dataset's
frozen clock, installed like golden.py's child). Offline like golden.py.

Every write goes through the app's own entry points (the FastAPI endpoint functions, else the service
the CLI calls), one Python transaction each, on deterministic targets: profile ordinal 0 (the lowest
profile id), the lowest id of the needed kind. Values are synthetic (``bridge-test-<n>`` titles,
``BRIDGE TEST <n>`` merchants, round amounts). A bullet whose rows the dataset lacks is skipped and
counted. Output: one JSON line of counts per run (``{"phase", "dataset", "txns", "files", "steps",
"skipped"}``), never values, ids or slugs; a failure prints the step and the exception type (the
traceback goes to ``<run>/bridge-writes.log``) and exits 1.

Phases (spec 9.3): A = the main set (lab: investments; demo adds the budget, assets and loans writes and
a small synthetic mBank CSV import written under the run dir); B = six more of the same kinds, in three parts of two (``--part``, one per crash point of the kill test); C = one
local edit of the alert whose title phase A edited (the inbound-then-local sequence); R = an
overlapping broker re-import (2 txns, after C); M = a merge of an instrument phase A watched, already
shipped (1 txn, after R).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pwd
import sys
import traceback
from collections import Counter
from collections.abc import Callable
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARITY_ROOT = Path(pwd.getpwuid(os.getuid()).pw_dir) / "cashu-lab" / "parity"
"""The real user's parity tree (``$HOME`` points into the run dir under ``safe_env``)."""
DEMO_SOURCE = PARITY_ROOT / "demo-data"
CATEGORY = "groceries"
OTHER_CATEGORY = "fuel"


class Skip(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _inside(path: Path, root: Path) -> bool:
    real, base = os.path.realpath(path).casefold(), os.path.realpath(root).casefold()
    return real.startswith(base.rstrip(os.sep) + os.sep)


def data_dir_allowed(data: Path) -> bool:
    """A run copy inside the parity tree, never the demo dataset source itself."""
    return _inside(data, PARITY_ROOT) and not (
        os.path.realpath(data).casefold() == os.path.realpath(DEMO_SOURCE).casefold()
        or _inside(data, DEMO_SOURCE)
    )


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #


class Run:
    def __init__(self, dataset: str, phase: str, profile, today: dt.date, run_dir: Path) -> None:
        self.dataset, self.phase = dataset, phase
        self.profile, self.today, self.run_dir = profile, today, run_dir
        self.part: int | None = None
        self.txns = 0
        self.files = 0
        self.steps: Counter[str] = Counter()
        self.skipped: Counter[str] = Counter()

    def txn(self, step: str, call: Callable[[], object]) -> object:
        """One Python transaction (one endpoint / service call that commits)."""
        out = call()
        if isinstance(out, dict) and out.get("error"):
            raise RuntimeError(f"{step}: the endpoint refused the write")
        self.txns += 1
        self.steps[step] += 1
        return out

    def step(self, name: str, body: Callable[[Run], None]) -> None:
        try:
            body(self)
        except Skip as s:
            self.skipped[f"{name}:{s.reason}"] += 1
        except Exception as e:
            e.add_note(f"bridge step {name}")
            raise

    def summary(self) -> dict:
        return {
            "phase": self.phase,
            "part": self.part,
            "dataset": self.dataset,
            "txns": self.txns,
            "files": self.files,
            "steps": dict(sorted(self.steps.items())),
            "skipped": dict(sorted(self.skipped.items())),
        }


def _session():
    from cashu.core.db import get_session

    return get_session()


def _first(query) -> int:
    with _session() as s:
        row = s.exec(query).first()
    if row is None:
        raise Skip("no-row")
    return row


# --------------------------------------------------------------------------- #
# Deterministic targets
# --------------------------------------------------------------------------- #


def _signals(pid: int, *, status: str, severity: str | None = None) -> list[int]:
    from sqlmodel import select

    from cashu.modules.investments.models import InvSignal

    q = select(InvSignal.id).where(InvSignal.profile_id == pid, InvSignal.status == status)
    if severity is not None:
        q = q.where(InvSignal.severity == severity)
    with _session() as s:
        return list(s.exec(q.order_by(InvSignal.id)).all())


def _alerts(pid: int) -> list[int]:
    """The profile's alerts in id order (deleted ones excluded): the first is muted / unmuted, the
    second (or the first when there is one) gets the title edits of phases A, B and C."""
    from sqlmodel import select

    from cashu.modules.investments.models import InvAlert

    with _session() as s:
        return list(
            s.exec(
                select(InvAlert.id)
                .where(InvAlert.profile_id == pid, InvAlert.status != "deleted")
                .order_by(InvAlert.id)
            ).all()
        )


def _alert_pair(pid: int) -> tuple[int, int]:
    ids = _alerts(pid)
    if not ids:
        raise Skip("no-alert")
    return ids[0], ids[1] if len(ids) > 1 else ids[0]


def _unread_note(pid: int, *, skip: int = 0) -> int:
    from sqlmodel import select

    from cashu.modules.investments.models import InvResearchNote

    with _session() as s:
        ids = s.exec(
            select(InvResearchNote.id)
            .where(
                InvResearchNote.profile_id == pid,
                InvResearchNote.kind != "candidate",
                InvResearchNote.read_at.is_(None),
                InvResearchNote.dismissed_at.is_(None),
            )
            .order_by(InvResearchNote.id)
        ).all()
    if len(ids) <= skip:
        raise Skip("no-unread-note")
    return ids[skip]


def _first_watch(pid: int):
    from sqlmodel import select

    from cashu.modules.investments.models import InvWatchlistItem

    with _session() as s:
        row = s.exec(
            select(InvWatchlistItem)
            .where(InvWatchlistItem.profile_id == pid)
            .order_by(InvWatchlistItem.id)
        ).first()
        if row is None:
            raise Skip("no-watchlist-item")
        return row.id, row.instrument_id


# --------------------------------------------------------------------------- #
# Investments (both datasets)
# --------------------------------------------------------------------------- #


def ack_signal(r: Run) -> None:
    """Acknowledge an active signal by a ``held`` decision (an info one when there is: it is the one
    the escalation step raises)."""
    from cashu.modules.investments import api

    pid = r.profile.id
    ids = _signals(pid, status="active", severity="info") or _signals(pid, status="active")
    if not ids:
        raise Skip("no-active-signal")
    r.txn("ack_signal", lambda: api.decide(r.profile, ids[0], api.DecisionBody(action="held")))


def mute_alert(r: Run) -> None:
    from cashu.modules.investments import api

    first, _ = _alert_pair(r.profile.id)
    r.txn("mute_alert", lambda: api.alert_update(r.profile, first, api.AlertPatchBody(status="muted")))


def edit_alert(r: Run, title: str, note: str | None, step: str) -> None:
    from cashu.modules.investments import api

    _, second = _alert_pair(r.profile.id)
    body = api.AlertPatchBody(title=title) if note is None else api.AlertPatchBody(title=title, note=note)
    r.txn(step, lambda: api.alert_update(r.profile, second, body))


def snooze_signal(r: Run) -> None:
    from cashu.modules.investments import api

    ids = _signals(r.profile.id, status="active")
    if not ids:
        raise Skip("no-active-signal")
    until = (r.today + dt.timedelta(days=7)).isoformat()
    r.txn("snooze_signal", lambda: api.snooze_signal(r.profile, ids[0], api.SnoozeBody(until=until)))


def decision_undo(r: Run) -> None:
    from cashu.modules.investments import api

    ids = _signals(r.profile.id, status="active")
    if not ids:
        raise Skip("no-active-signal")
    made = r.txn("decision_record", lambda: api.decide(r.profile, ids[0], api.DecisionBody(action="held")))
    decision_id = made["id"] if isinstance(made, dict) and "id" in made else made["decision"]["id"]
    r.txn("decision_undo", lambda: api.decision_undo(r.profile, decision_id))


def read_note(r: Run, step: str = "note_read") -> None:
    from cashu.modules.investments import research_api

    nid = _unread_note(r.profile.id)
    r.txn(step, lambda: research_api.research_read(r.profile, research_api.ReadBody(ids=[nid])))


def dismiss_note(r: Run) -> None:
    from cashu.modules.investments import research_api

    nid = _unread_note(r.profile.id)
    r.txn(
        "note_dismiss",
        lambda: research_api.research_note_update(r.profile, nid, research_api.NotePatch(dismissed=True)),
    )


def watch_new_instrument(r: Run) -> None:
    """Watch an instrument the profile does not reference yet (the shipper snapshots its closure).
    The app adds a stored instrument the profile does not know by its ISIN or a Yahoo alias (the
    ``instrument_id`` form only takes the profile's own instruments)."""
    from sqlmodel import select

    from cashu.modules.investments import api
    from cashu.modules.investments.models import InvInstrument, InvInstrumentAlias
    from cashu.modules.investments.store import instruments

    with _session() as s:
        known = instruments.profile_instrument_ids(s, r.profile.id)
        ref = None
        for inst in s.exec(select(InvInstrument).order_by(InvInstrument.id)).all():
            if inst.id in known:
                continue
            alias = s.exec(
                select(InvInstrumentAlias.value)
                .where(InvInstrumentAlias.instrument_id == inst.id, InvInstrumentAlias.namespace == "yahoo")
                .order_by(InvInstrumentAlias.id)
            ).first()
            ref = inst.isin or alias
            if ref:
                break
    if not ref:
        raise Skip("no-unreferenced-instrument")
    body = api.WatchBody(symbol_or_isin=ref, note="bridge-test-watch")
    r.txn("watch_add", lambda: api.watchlist_add(r.profile, body))


def thesis_cycle(r: Run) -> None:
    from sqlmodel import select

    from cashu.modules.investments import api
    from cashu.modules.investments.models import InvThesis, InvWatchlistItem

    pid = r.profile.id
    with _session() as s:
        have = set(s.exec(select(InvThesis.instrument_id).where(InvThesis.profile_id == pid)).all())
        watched = s.exec(
            select(InvWatchlistItem.instrument_id)
            .where(InvWatchlistItem.profile_id == pid)
            .order_by(InvWatchlistItem.id)
        ).all()
    free = [i for i in watched if i not in have]
    if not free:
        raise Skip("no-instrument-without-thesis")
    made = r.txn(
        "thesis_create",
        lambda: api.thesis_create(r.profile, free[0], api.ThesisBody(entry_type="trend", thesis="bridge-test-thesis")),
    )
    tid = made["id"]
    r.txn(
        "thesis_update",
        lambda: api.thesis_update(r.profile, tid, api.ThesisBody(thesis="bridge-test-thesis-2", invalidation="bridge-test-invalidation")),
    )
    r.txn("thesis_delete", lambda: api.thesis_delete(r.profile, tid))


def manual_valuation(r: Run, value: str, days_back: int, step: str) -> None:
    from cashu.modules.investments import api

    _, instrument_id = _first_watch(r.profile.id)
    body = api.ManualValuationBody(
        instrument_id=instrument_id, unit_value=value, as_of=r.today - dt.timedelta(days=days_back)
    )
    r.txn(step, lambda: api.manual_valuation_add(r.profile, body))


def review_cycle(r: Run) -> None:
    from cashu.core import agent_api

    made = r.txn(
        "review_done",
        lambda: agent_api.create_review(r.profile, agent_api.ReviewBody(module="investments", notes="bridge-test-review")),
    )
    rid = made["id"]
    r.txn("review_undo", lambda: agent_api.undo_review(r.profile, rid))


def escalate_acknowledged(r: Run) -> None:
    """The rule engine's EscalateSignal on an acknowledged signal (store/signals.py
    ``apply_reconciliation``): severity up one rank, reactivated (the P-C evidence)."""
    from cashu.core.db import get_session
    from cashu.modules.investments.domain.enums import SignalSeverity
    from cashu.modules.investments.models import InvSignal
    from cashu.modules.investments.rules.lifecycle import EscalateSignal, SignalReconciliation
    from cashu.modules.investments.rules.outcomes import SignalCandidate
    from cashu.modules.investments.rules.polarity import SignalPolarity
    from cashu.modules.investments.store import signals as signal_store

    order = list(SignalSeverity)
    ids = [
        i
        for sev in order[:-1]
        for i in _signals(r.profile.id, status="acknowledged", severity=sev.value)
    ]
    if not ids:
        raise Skip("no-acknowledged-signal-below-top")
    sid = min(ids)

    def write() -> None:
        with get_session() as s:
            row = s.get(InvSignal, sid)
            before = SignalSeverity(row.severity)
            candidate = SignalCandidate(
                rule_id=row.rule_id,
                kind=row.kind,
                dedup_key=row.dedup_key,
                severity=order[order.index(before) + 1],
                message=row.message,
                instrument_id=row.instrument_id,
                account_id=row.account_id,
                payload=dict(row.payload or {}),
                polarity=SignalPolarity(row.polarity),
            )
            action = EscalateSignal(
                signal_id=sid,
                candidate=candidate,
                previous_severity=before,
                reactivate=True,
                seen_at=dt.datetime.now(dt.UTC),
            )
            signal_store.apply_reconciliation(
                s, r.profile.id, SignalReconciliation(actions=(action,)), run_id=None, notify=frozenset()
            )

    r.txn("signal_escalate", write)


def candidate_cycle(r: Run) -> None:
    from sqlmodel import select

    from cashu.modules.investments import research_api
    from cashu.modules.investments.models import InvResearchNote

    with _session() as s:
        rows = s.exec(
            select(InvResearchNote.id, InvResearchNote.details)
            .where(
                InvResearchNote.profile_id == r.profile.id,
                InvResearchNote.kind == "candidate",
                InvResearchNote.dismissed_at.is_(None),
            )
            .order_by(InvResearchNote.id)
        ).all()
    from fastapi import HTTPException

    for nid, details in rows:
        if (details or {}).get("accepted_at"):
            continue
        try:  # the first candidate the app accepts; a refusal (4xx, rolled back) is counted
            r.txn("candidate_accept", lambda nid=nid: research_api.research_candidate_accept(r.profile, nid))
        except HTTPException as e:
            if e.status_code >= 500:
                raise
            r.skipped[f"candidate:refused-{e.status_code}"] += 1
            continue
        r.txn("candidate_undo", lambda nid=nid: research_api.research_candidate_unaccept(r.profile, nid))
        return
    raise Skip("no-acceptable-candidate")


# --------------------------------------------------------------------------- #
# Budget, assets, loans (demo)
# --------------------------------------------------------------------------- #

CSV_ROWS = (
    (3, "BRIDGE TEST 1", "-20,00"),
    (3, "BRIDGE TEST 1", "-20,00"),  # a repeat on the same day: occurrence 1
    (2, "BRIDGE TEST 3", "-30,00"),
    (1, "BRIDGE TEST 4", "100,00"),
)


def import_csv_statement(r: Run) -> None:
    """A small synthetic mBank CSV through the importer (``cashu import`` path)."""
    from cashu.modules.budget.service import import_csv

    folder = r.run_dir / "bridge-writes"
    folder.mkdir(mode=0o700, exist_ok=True)
    path = folder / "bridge-test-mbank.csv"
    balance = 1000
    lines = ["mBank S.A.", "Lista operacji", "#Data operacji;#Opis operacji;#Kwota;#Waluta;#Saldo po operacji"]
    for days_back, title, amount in CSV_ROWS:
        balance += int(amount.replace(",00", ""))
        day = (r.today - dt.timedelta(days=days_back)).isoformat()
        lines.append(f"{day};{title};{amount};PLN;{balance},00")
    path.write_text("\n".join(lines) + "\n", encoding="cp1250")

    def write() -> None:
        with _session() as s:
            import_csv(s, path, bank="mbank", account_name="bridge-test-import", profile_id=r.profile.id)

    r.txn("csv_import", write)


def categorize_txn(r: Run) -> None:
    from sqlmodel import select

    from cashu.core.models import Account
    from cashu.modules.budget import api
    from cashu.modules.budget.cash import cash_account_ids
    from cashu.modules.budget.models import Transaction

    with _session() as s:
        cash = cash_account_ids(s, r.profile.id)
        row = s.exec(
            select(Transaction.id, Transaction.category)
            .join(Account, Account.id == Transaction.account_id)
            .where(Account.profile_id == r.profile.id, Transaction.amount < 0)
            .where(Transaction.account_id.not_in(cash) if cash else True)
            .order_by(Transaction.id)
        ).first()
    if row is None:
        raise Skip("no-transaction")
    category = OTHER_CATEGORY if row[1] != OTHER_CATEGORY else CATEGORY
    r.txn("txn_category", lambda: api.set_transaction_category(r.profile, row[0], {"category": category}))


def locked_rule(r: Run) -> None:
    from cashu.modules.budget import api
    from cashu.modules.budget.ingestion.normalize import merchant_key

    payload = {"merchant_key": merchant_key("BRIDGE TEST 1"), "category": CATEGORY}
    r.txn("rule_locked", lambda: api.set_merchant_category(r.profile, payload))


def _account(r: Run, kind: str) -> int:
    from sqlmodel import select

    from cashu.core.models import Account

    with _session() as s:
        aid = s.exec(
            select(Account.id).where(Account.profile_id == r.profile.id, Account.type == kind).order_by(Account.id)
        ).first()
    if aid is None:
        raise Skip(f"no-{kind}-account")
    return aid


def add_balance(r: Run) -> None:
    from cashu.modules.assets import api

    aid = _account(r, "property")
    body = api.ManualPatch(value=500000.0, on_date=r.today)
    r.txn("balance_add", lambda: api.patch_manual_position(r.profile, aid, body))


def rename_account(r: Run) -> None:
    """``cashu accounts name`` (``core/cli.py`` ``set_account_name``): the only rename path."""
    from cashu.core.models import Account

    aid = _account(r, "checking")

    def write() -> None:
        with _session() as s:
            acc = s.get(Account, aid)
            acc.name = "bridge-test-account"
            s.add(acc)

    r.txn("account_rename", write)


def cash_cycle(r: Run) -> None:
    from cashu.modules.budget import api

    made = r.txn(
        "cash_add",
        lambda: api.add_cash_expense_ep(r.profile, {"amount": 50, "title": "BRIDGE TEST 2", "category": CATEGORY}),
    )
    tid = made["id"]
    r.txn("cash_delete", lambda: api.delete_cash_txn_ep(r.profile, tid))


def loan_phrase(r: Run) -> None:
    from sqlmodel import select

    from cashu.core.models import Account
    from cashu.modules.loans import api
    from cashu.modules.loans.models import Loan

    with _session() as s:
        lid = s.exec(
            select(Loan.id)
            .join(Account, Account.id == Loan.account_id)
            .where(Account.profile_id == r.profile.id)
            .order_by(Loan.id)
        ).first()
    if lid is None:
        raise Skip("no-loan")
    r.txn("loan_phrase", lambda: api.patch_payment(r.profile, lid, api.PaymentPatch(text="BRIDGE TEST RATA")))


def set_depreciation(r: Run) -> None:
    from cashu.modules.assets import api

    aid = _account(r, "vehicle")
    body = api.ManualPatch(depreciation=api.DepreciationBody(annual_rate=0.1))
    r.txn("depreciation_set", lambda: api.patch_manual_position(r.profile, aid, body))


def set_cushion(r: Run) -> None:
    """The cushion in ``profiles/<slug>/budget.json`` the way the app writes it (PUT budget settings):
    a file, not a DB transaction (D7: the daemon diffs it)."""
    from cashu.modules.budget import api

    current = api.get_budget_settings(r.profile)
    cushion = dict(current["cushion"])
    cushion.update({"enabled": True, "target_amount": 20000, "target_months": None})
    api.put_budget_settings(r.profile, {"cushion": cushion})
    r.files += 1
    r.steps["cushion_set"] += 1


# --------------------------------------------------------------------------- #
# Phases
# --------------------------------------------------------------------------- #


def phase_a(r: Run) -> None:
    r.step("ack_signal", ack_signal)
    r.step("mute_alert", mute_alert)
    r.step("edit_alert", lambda r: edit_alert(r, "bridge-test-title", "bridge-test-note", "alert_edit"))
    r.step("snooze_signal", snooze_signal)
    r.step("decision_undo", decision_undo)
    r.step("note_read", read_note)
    r.step("note_dismiss", dismiss_note)
    r.step("watch_add", watch_new_instrument)
    r.step("thesis", thesis_cycle)
    r.step("valuation", lambda r: manual_valuation(r, "100", 0, "valuation_set"))
    r.step("review", review_cycle)
    r.step("escalate", escalate_acknowledged)
    r.step("candidate", candidate_cycle)
    if r.dataset == "demo":
        r.step("csv_import", import_csv_statement)
        r.step("txn_category", categorize_txn)
        r.step("rule_locked", locked_rule)
        r.step("balance_add", add_balance)
        r.step("account_rename", rename_account)
        r.step("cash", cash_cycle)
        r.step("loan_phrase", loan_phrase)
        r.step("depreciation", set_depreciation)
        r.step("cushion", set_cushion)


def unmute_alert(r: Run) -> None:
    from cashu.modules.investments import api

    first, _ = _alert_pair(r.profile.id)
    r.txn("alert_unmute", lambda: api.alert_update(r.profile, first, api.AlertPatchBody(status="active")))


def unsnooze_signal(r: Run) -> None:
    from sqlmodel import select

    from cashu.modules.investments import api
    from cashu.modules.investments.models import InvSignal

    with _session() as s:
        sid = s.exec(
            select(InvSignal.id)
            .where(
                InvSignal.profile_id == r.profile.id,
                InvSignal.snoozed_until.is_not(None),
                InvSignal.status.in_(("active", "acknowledged")),
            )
            .order_by(InvSignal.id)
        ).first()
    if sid is None:
        raise Skip("no-snoozed-signal")
    r.txn("signal_unsnooze", lambda: api.snooze_signal(r.profile, sid, api.SnoozeBody(until=None)))


def watch_note(r: Run) -> None:
    from cashu.modules.investments import api

    item_id, _ = _first_watch(r.profile.id)
    r.txn("watch_note", lambda: api.watchlist_update(r.profile, item_id, api.WatchPatchBody(note="bridge-test-watch-b")))


def phase_b(r: Run, part: int | None = None) -> None:
    """Six transactions in three parts of two (the kill test runs one part per crash point); no
    ``--part`` = all three in order."""
    if part in (None, 1):
        r.step("alert_unmute", unmute_alert)
        r.step("alert_edit_b", lambda r: edit_alert(r, "bridge-test-title-b", None, "alert_edit_b"))
    if part in (None, 2):
        r.step("signal_unsnooze", unsnooze_signal)
        r.step("note_read_b", lambda r: read_note(r, "note_read_b"))
    if part in (None, 3):
        r.step("valuation_b", lambda r: manual_valuation(r, "110", 1, "valuation_set_b"))
        r.step("watch_note", watch_note)


def phase_c(r: Run) -> None:
    r.step("alert_edit_c", lambda r: edit_alert(r, "bridge-test-title-c", None, "alert_edit_c"))


# --------------------------------------------------------------------------- #
# Phase R: an overlapping broker re-import; phase M: a merge of a shipped instrument
# --------------------------------------------------------------------------- #

BROKER_HEADER = (
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,"
    "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source"
)


def _broker_file(r: Run, second: bool) -> bytes:
    """A synthetic export in cashU's own broker format: two instruments bought, their positions on
    day D; the second file repeats every row of the first (D positions identical) and adds one buy
    and the positions of a later day D2."""
    d1 = (r.today - dt.timedelta(days=10)).isoformat()
    d2 = (r.today - dt.timedelta(days=3)).isoformat()
    t0 = (r.today - dt.timedelta(days=20)).isoformat()
    rows = [
        f"1,txn,{t0},09:00,deposit,BRIDGE-TEST-1,,,,,,,PLN,,,,10000.00,,,,",
        f"1,txn,{t0},10:00,buy,BRIDGE-TEST-2,BRTA,,BRIDGE TEST 5 SA,XWAR,10,100.00,PLN,1000.00,,,-1000.00,,,,",
        f"1,txn,{t0},11:00,buy,BRIDGE-TEST-3,BRTB,,BRIDGE TEST 6 SA,XWAR,20,50.00,PLN,1000.00,,,-1000.00,,,,",
        f"1,position,{d1},,,,BRTA,,BRIDGE TEST 5 SA,XWAR,10,,PLN,,,,,,,,",
        f"1,position,{d1},,,,BRTB,,BRIDGE TEST 6 SA,XWAR,20,,PLN,,,,,,,,",
    ]
    if second:
        rows += [
            f"1,txn,{d1},10:00,buy,BRIDGE-TEST-4,BRTA,,BRIDGE TEST 5 SA,XWAR,5,100.00,PLN,500.00,,,-500.00,,,,",
            f"1,position,{d2},,,,BRTA,,BRIDGE TEST 5 SA,XWAR,15,,PLN,,,,,,,,",
            f"1,position,{d2},,,,BRTB,,BRIDGE TEST 6 SA,XWAR,20,,PLN,,,,,,,,",
        ]
    return ("\n".join([BROKER_HEADER, *rows]) + "\n").encode("utf-8")


def broker_reimport(r: Run) -> None:
    """Two imports through the real importer (preview, then commit: the app's import flow) into the
    profile's lowest-id brokerage account; the second overlaps the first."""
    from cashu.core.models import Profile
    from cashu.modules.investments.importing import ImportFile
    from cashu.modules.investments.service import imports

    aid = _account(r, "brokerage")
    for n, second in ((1, False), (2, True)):
        content = _broker_file(r, second)

        def write(content=content, n=n) -> None:
            with _session() as s:
                profile = s.get(Profile, r.profile.id)
                plan = imports.preview(
                    s, profile, imports.ImportRequest(ImportFile(f"bridge-test-{n}.csv", content), aid)
                )
            if not plan.can_commit:
                raise RuntimeError("the import preview refused the synthetic file")
            imports.commit(plan)

        r.txn(f"broker_import_{n}", write)


def phase_r(r: Run) -> None:
    r.step("broker_reimport", broker_reimport)


def merge_shipped_instrument(r: Run) -> None:
    """Merge the instrument phase A watched (already shipped; else the profile's lowest-id
    instrument) into the lowest-id other instrument of the same currency without an ISIN conflict,
    through ``store.instrument_merge`` (the ``cashu invest instruments merge`` path: a dry run
    first, then the merge in one transaction)."""
    from sqlmodel import select

    from cashu.modules.investments.models import InvInstrument, InvWatchlistItem
    from cashu.modules.investments.store import instrument_merge, instruments

    with _session() as s:
        source = s.exec(
            select(InvWatchlistItem.instrument_id)
            .where(InvWatchlistItem.profile_id == r.profile.id, InvWatchlistItem.note == "bridge-test-watch")
            .order_by(InvWatchlistItem.id)
        ).first()
        if source is None:
            known = sorted(instruments.profile_instrument_ids(s, r.profile.id))
            if not known:
                raise Skip("no-instrument")
            source = known[0]
        src = s.get(InvInstrument, source)
        target = None
        for inst in s.exec(select(InvInstrument).order_by(InvInstrument.id)).all():
            if inst.id == source or (inst.currency or "").upper() != (src.currency or "").upper():
                continue
            if src.isin and inst.isin and src.isin.upper() != inst.isin.upper():
                continue
            target = inst.id
            break
    if target is None:
        raise Skip("no-merge-target")
    with _session() as s:
        instrument_merge.merge_instruments(s, source, target, dry_run=True)

    def write() -> None:
        with _session() as s:
            instrument_merge.merge_instruments(s, source, target)

    r.txn("instrument_merge", write)


def phase_m(r: Run) -> None:
    r.step("instrument_merge", merge_shipped_instrument)


PHASES = {"A": phase_a, "B": phase_b, "C": phase_c, "R": phase_r, "M": phase_m}


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", choices=("lab", "demo"), required=True)
    parser.add_argument("--phase", choices=tuple(PHASES), required=True)
    parser.add_argument("--part", type=int, choices=(1, 2, 3), help="Phase B only: one part of two txns.")
    args = parser.parse_args(argv)
    if args.part is not None and args.phase != "B":
        parser.error("--part is for phase B only")

    sys.path.insert(0, str(HERE))
    import offline

    offline.install()

    from cashu.core import paths

    data = paths.data_dir()
    if not data_dir_allowed(data):
        print(json.dumps({"phase": args.phase, "error": "data dir is not a run copy under ~/cashu-lab/parity/"}))
        return 2
    if os.environ.get("CASHU_SYNC") != "1":
        print(json.dumps({"phase": args.phase, "error": "needs CASHU_SYNC=1"}))
        return 2

    import golden

    golden.import_all()
    clock = os.environ.get("CASHU_PARITY_CLOCK")
    if clock:
        import frozen

        frozen.install(clock)
    from cashu.core.db import init_db

    init_db()
    golden.offline_sources()

    from sqlmodel import select

    from cashu.core.models import Profile

    with _session() as s:
        profile = s.exec(select(Profile).where(Profile.id > 0).order_by(Profile.id)).first()
        if profile is None:
            print(json.dumps({"phase": args.phase, "error": "no profile"}))
            return 1
        s.expunge(profile)
    today = dt.date.today()
    run = Run(args.dataset, args.phase, profile, today, data.parent)
    run.part = args.part
    try:
        if args.phase == "B":
            phase_b(run, args.part)
        else:
            PHASES[args.phase](run)
    except Exception as e:  # noqa: BLE001 - the type only on stdout; the traceback goes to the run log
        with (data.parent / "bridge-writes.log").open("a", encoding="utf-8") as fh:
            fh.write(f"--- phase {args.phase}\n{traceback.format_exc()}\n")
        notes = [n for n in getattr(e, "__notes__", []) if n.startswith("bridge step ")]
        out = run.summary() | {"error": type(e).__name__, "step": notes[-1][12:] if notes else None}
        print(json.dumps(out, sort_keys=True))
        return 1
    print(json.dumps(run.summary(), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
