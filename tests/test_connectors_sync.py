"""Fetch connector sync (F10 BE-C3): the first sync is a proposal, approving it commits and saves the
cursor, auto-commit only after an approved commit and only for a clean preview, cursor conflicts,
binding / connector gates on approval, the per-binding busy lock, rate-limit backoff, due bindings for
the module sync actions and the worker job, runs / diff routes. Synthetic data, NoSandbox, in-memory
keyring.

The test connector answers ``fetch`` from a JSON file whose path is the binding's ``fixture`` param
(only possible without the sandbox): ``{"document": ..., "cursor": ...}`` or ``{"error": ...}``."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from connector_support import (  # noqa: F401  (fixture)
    NoSandbox,
    memory_keyring,
    needs_python3,
    write_connector,
)
from sqlmodel import select

from finanse.core import profiles
from finanse.core.agent_models import Proposal
from finanse.core.connectors import runner, service, sync
from finanse.core.connectors.models import ConnectorBinding, ConnectorRun
from finanse.core.db import get_session

pytestmark = needs_python3

FIXTURE_CONNECTOR = '''\
import json, sys
req = json.load(sys.stdin)
if req["command"] == "check":
    print(json.dumps({"ok": True}))
    sys.exit(0)
with open(req["params"]["fixture"]) as f:
    fx = json.load(f)
if "error" in fx:
    print(json.dumps({"error": fx["error"]}))
    sys.exit(1)
sys.stderr.write("fetched records\\n")
out = {"document": fx["document"]}
if fx.get("cursor") is not None:
    out["cursor"] = fx["cursor"]
print(json.dumps(out))
'''


def deposit(day: str, ref: str, amount: str = "100.00") -> dict:
    return {"record": "txn", "date": day, "type": "deposit", "currency": "PLN",
            "gross_amount": amount, "external_ref": ref}


def inv_doc(*records: dict) -> dict:
    return {"format": "finanse-import", "format_version": 1, "source": "demo_broker",
            "records": list(records)}


def bud_doc(*txns: dict) -> dict:
    return {"format": "finanse-budget-import", "format_version": 1, "source": "demo_bank",
            "account": {"currency": "PLN"}, "transactions": list(txns)}


def bud_txn(day: str, tid: str, amount: str = "-12.50") -> dict:
    return {"booking_date": day, "amount": amount, "currency": "PLN", "description": "Zakupy TEST",
            "transaction_id": tid}


@pytest.fixture
def sandbox(monkeypatch):
    box = NoSandbox()
    monkeypatch.setattr(runner, "default_sandbox", lambda: box)
    return box


@pytest.fixture
def client(api_empty, memory_keyring, sandbox):  # noqa: F811
    return api_empty


class Setup:
    def __init__(self, client, tmp_path: Path, module: str = "investments"):
        self.client, self.tmp = client, tmp_path
        r = client.post("/api/profiles", json={"name": "Jan Test", "modules": ["investments", "budget"]})
        assert r.status_code == 201, r.text
        self.slug = r.json()["slug"]
        if module == "investments":
            r = client.post(f"/api/p/{self.slug}/investments/accounts",
                            json={"name": "Broker TEST", "broker": "dif", "wrapper": "regular"})
            assert r.status_code == 201, r.text
            self.account = r.json()["id"]
        else:
            from finanse.core.accounts import get_or_create_account

            with get_session() as s:
                p = profiles.get_by_slug(s, self.slug)
                self.account = get_or_create_account(
                    s, bank="mbank", name="Konto TEST", profile_id=p.id
                ).id
        cid = "demo-fetch" if module == "investments" else "demo-bank"
        self.cid = cid
        src = write_connector(tmp_path / "src" / cid, cid=cid, kind="fetch", module=module,
                              code=FIXTURE_CONNECTOR)
        service.install(src)
        d = client.get(f"/api/connectors/{cid}").json()
        assert client.post(f"/api/connectors/{cid}/approve", json={
            "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]
        }).status_code == 200
        self.fixture = tmp_path / f"fixture-{cid}.json"
        r = client.post(f"/api/p/{self.slug}/connectors/bindings", json={
            "account_id": self.account, "connector_id": cid,
            "params": {"fixture": str(self.fixture)}, "secrets": {"api_key": "key-TEST"},
        })
        assert r.status_code == 201, r.text
        self.binding = r.json()["id"]
        self.base = f"/api/p/{self.slug}"

    def answer(self, document: dict | None = None, cursor: str | None = None, error=None) -> None:
        body = {"error": error} if error else {"document": document, "cursor": cursor}
        self.fixture.write_text(json.dumps(body), encoding="utf-8")

    def sync(self):
        return self.client.post(f"{self.base}/connectors/bindings/{self.binding}/sync")

    def binding_row(self) -> ConnectorBinding:
        with get_session() as s:
            return s.get(ConnectorBinding, self.binding)

    def profile(self):
        with get_session() as s:
            return profiles.get_by_slug(s, self.slug)

    def approve(self, pid: int):
        return self.client.post(f"{self.base}/proposals/{pid}/approve")

    def set_auto(self, on: bool = True) -> None:
        r = self.client.put(f"{self.base}/connectors/bindings/{self.binding}", json={"auto_commit": on})
        assert r.status_code == 200, r.text


def inv_count(account: int) -> int:
    from finanse.modules.investments.models import InvTransaction

    with get_session() as s:
        return len(s.exec(select(InvTransaction).where(InvTransaction.account_id == account)).all())


def bud_count(account: int) -> int:
    from finanse.modules.budget.models import Transaction

    with get_session() as s:
        return len(s.exec(select(Transaction).where(Transaction.account_id == account)).all())


# --------------------------------------------------------------------------- #
# Investments
# --------------------------------------------------------------------------- #


def test_first_sync_is_a_proposal_and_approving_saves_the_cursor(client, tmp_path, sandbox):
    st = Setup(client, tmp_path)
    st.set_auto(True)  # still a proposal: no approved commit yet
    st.answer(inv_doc(deposit("2026-09-01", "d1"), deposit("2026-09-02", "d2")), cursor="c1")
    r = st.sync()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run"]["ok"] is True and body["run"]["stderr_tail"]
    assert body["preview"]["new"] == 2 and body["preview"]["blocking"] == 0
    assert body["committed"] is None and body["proposal_id"]
    assert body["account"] == "Broker TEST" and body["connector_name"] == "Test fetch"
    request = json.loads(sandbox.specs[-1].stdin)
    assert request["cursor"] is None and request["secrets"] == {"api_key": "key-TEST"}
    assert inv_count(st.account) == 0
    row = st.binding_row()
    assert row.cursor is None and row.last_ok_at is None and row.last_status == "ok"

    detail = client.get(f"{st.base}/proposals/{body['proposal_id']}").json()
    assert detail["kind"] == "import" and detail["source"] == "connector"
    assert detail["payload"]["source"] == "connector" and detail["payload"]["cursor"] == "c1"
    assert detail["connector_name"] == "Test fetch" and detail["since"] == body["since"]
    assert detail["summary_params"]["connector"] == "Test fetch"
    assert "key-TEST" not in json.dumps(detail)
    with get_session() as s:
        run = s.get(ConnectorRun, body["run"]["run_id"])
        assert run.proposal_id == body["proposal_id"]

    approved = st.approve(body["proposal_id"])
    assert approved.status_code == 200, approved.text
    assert approved.json()["result"]["cursor_saved"] is True
    assert inv_count(st.account) == 2
    row = st.binding_row()
    assert row.cursor == "c1" and row.last_ok_at is not None
    binding = client.get(f"{st.base}/connectors/bindings/{st.binding}").json()
    assert binding["has_commit"] is True and binding["has_cursor"] is True
    assert binding["account_label"] == "Broker TEST"
    with get_session() as s:
        run = s.get(ConnectorRun, body["run"]["run_id"])
        assert run.batch_ref.startswith("investments:")

    # the next fetch starts at the committed cursor and day; clean -> committed automatically
    st.answer(inv_doc(deposit("2026-09-02", "d2"), deposit("2026-09-03", "d3")), cursor="c2")
    body = st.sync().json()
    request = json.loads(sandbox.specs[-1].stdin)
    assert request["cursor"] == "c1" and request["since"] == row.last_ok_at.date().isoformat()
    assert body["proposal_id"] is None and body["committed"]["inserted"] == 1
    assert body["committed"]["duplicates"] == 1 and inv_count(st.account) == 3
    assert st.binding_row().cursor == "c2"


def test_auto_commit_only_for_a_clean_preview(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    assert st.approve(st.sync().json()["proposal_id"]).status_code == 200
    st.set_auto(True)
    # a warning (a fee with a positive cash amount) -> a proposal, the cursor stays
    fee = {"record": "txn", "date": "2026-09-05", "type": "fee", "currency": "PLN",
           "gross_amount": "5.00", "cash_amount": "5.00", "external_ref": "f1"}
    st.answer(inv_doc(fee), cursor="c2")
    body = st.sync().json()
    assert body["preview"]["warnings"] >= 1 and body["proposal_id"] and body["committed"] is None
    assert st.binding_row().cursor == "c1"
    assert client.post(f"{st.base}/proposals/{body['proposal_id']}/reject").status_code == 200
    # a new instrument is not "only new records" either
    buy = {"record": "txn", "date": "2026-09-06", "type": "buy", "symbol": "TEST", "exchange": "XWAR",
           "currency": "PLN", "quantity": "1", "price": "10.00", "gross_amount": "10.00",
           "external_ref": "b1"}
    st.answer(inv_doc(buy), cursor="c3")
    body = st.sync().json()
    assert body["preview"]["new_instruments"] == 1 and body["proposal_id"]
    assert client.post(f"{st.base}/proposals/{body['proposal_id']}/reject").status_code == 200
    # auto-commit off -> always a proposal
    st.set_auto(False)
    st.answer(inv_doc(deposit("2026-09-07", "d7")), cursor="c4")
    assert st.sync().json()["proposal_id"]


def test_nothing_new_saves_the_cursor_only_after_a_commit(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(inv_doc(), cursor="c0")
    body = st.sync().json()
    assert body["preview"]["new"] == 0 and body["proposal_id"] is None and body["committed"] is None
    assert st.binding_row().cursor is None  # before the first commit nothing is saved
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    assert st.approve(st.sync().json()["proposal_id"]).status_code == 200
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c9")  # only a duplicate
    body = st.sync().json()
    assert body["preview"]["new"] == 0 and body["proposal_id"] is None
    assert st.binding_row().cursor == "c9"


def test_cursor_conflict_binding_missing_and_not_approved(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    first = st.sync().json()["proposal_id"]
    st.answer(inv_doc(deposit("2026-09-01", "d1"), deposit("2026-09-02", "d2")), cursor="c2")
    with get_session() as s:  # the binding moved on since the first fetch (another commit)
        assert sync.save_cursor(s, st.binding, base_cursor=None, base_ok_at=None, cursor="c2",
                                fetched_at=dt.datetime(2026, 9, 2, 12, 0, tzinfo=dt.UTC))
    r = st.approve(first)
    assert r.status_code == 422 and r.headers["X-Finanse-Error-Code"] == "cursor_conflict"
    assert inv_count(st.account) == 0 and st.binding_row().cursor == "c2"
    second = st.sync().json()["proposal_id"]
    assert st.approve(second).status_code == 200
    assert inv_count(st.account) == 2

    st.answer(inv_doc(deposit("2026-09-03", "d3")), cursor="c3")
    third = st.sync().json()["proposal_id"]
    client.post(f"/api/connectors/{st.cid}/disable")
    r = st.approve(third)
    assert r.status_code == 422 and r.headers["X-Finanse-Error-Code"] == "connector_not_approved"

    d = client.get(f"/api/connectors/{st.cid}").json()
    client.post(f"/api/connectors/{st.cid}/approve", json={
        "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]})
    fourth = st.sync().json()["proposal_id"]
    assert client.delete(f"{st.base}/connectors/bindings/{st.binding}").status_code == 200
    r = st.approve(fourth)
    assert r.status_code == 422 and r.headers["X-Finanse-Error-Code"] == "binding_missing"
    assert inv_count(st.account) == 2


def test_rejecting_removes_the_stored_document_and_keeps_the_cursor(client, tmp_path):
    from finanse.core import paths

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    pid = st.sync().json()["proposal_id"]
    with get_session() as s:
        staged = paths.data_dir() / s.get(Proposal, pid).payload["staged"]
    assert staged.is_file()
    assert client.post(f"{st.base}/proposals/{pid}/reject").status_code == 200
    assert not staged.exists() and st.binding_row().cursor is None


def test_failed_fetch_and_rate_limit_backoff(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(error={"kind": "rate_limited", "message": "slow down TEST"})
    body = st.sync().json()
    assert body["run"]["ok"] is False and body["run"]["error_kind"] == "rate_limited"
    assert body["run"]["message"] == "slow down TEST"  # the owner's view
    assert body["preview"] is None and body["proposal_id"] is None
    row = st.binding_row()
    backoff = row.backoff_until.replace(tzinfo=dt.UTC)
    assert dt.timedelta(hours=47) < backoff - dt.datetime.now(dt.UTC) <= dt.timedelta(hours=48)
    due = sync.due(st.profile(), "investments", dt.datetime.now(dt.UTC))
    assert [d.reason for d in due] == ["backoff"]


def test_blocking_preview_stores_nothing(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer({"format": "finanse-import", "format_version": 1, "records": [{"record": "txn"}]})
    body = st.sync().json()
    assert body["run"]["ok"] is True and body["preview"]["blocking"] >= 1
    assert body["problem"]["code"] == "import_blocked" and body["proposal_id"] is None
    assert client.get(f"{st.base}/proposals").json() == []


def test_busy_binding_answers_409(client, tmp_path):
    from finanse.core import locks

    st = Setup(client, tmp_path)
    st.answer(inv_doc(), cursor=None)
    with locks.run_lock(sync.lock_name(st.binding)):
        r = st.sync()
    assert r.status_code == 409 and r.headers["X-Finanse-Error-Code"] == "connector_busy"
    assert client.post(f"{st.base}/connectors/bindings/99999/sync").status_code == 404


def test_due_bindings_and_module_sync_actions(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    now = dt.datetime.now(dt.UTC)
    assert [d.reason for d in sync.due(st.profile(), "investments", now)] == [None]
    assert sync.due(st.profile(), "budget", now) == []
    # the investments run syncs the due binding first (offline: no)
    r = client.post(f"{st.base}/investments/run", json={"offline": True})
    assert r.status_code == 200 and "connectors" not in r.json()
    r = client.post(f"{st.base}/investments/run", json={})
    assert r.status_code == 200, r.text
    (line,) = r.json()["connectors"]
    assert line["proposal_id"] and line["skipped"] is None
    # its proposal waits: skipped with that proposal's id (BE-2), nothing runs
    (pending,) = sync.due(st.profile(), "investments", now)
    assert (pending.reason, pending.proposal_id) == ("pending_exists", line["proposal_id"])
    r = client.post(f"{st.base}/investments/run", json={})
    assert r.json()["connectors"][0] | {} == {
        "binding_id": st.binding, "connector_id": st.cid, "skipped": "pending_exists",
        "proposal_id": line["proposal_id"]}
    assert client.post(f"{st.base}/proposals/{line['proposal_id']}/reject").status_code == 200
    # tried now: not due again for 20 h
    assert [d.reason for d in sync.due(st.profile(), "investments", now)] == ["interval"]
    later = now + sync.MIN_INTERVAL + dt.timedelta(minutes=1)
    assert [d.reason for d in sync.due(st.profile(), "investments", later)] == [None]
    r = client.post(f"{st.base}/investments/run", json={})
    assert r.json()["connectors"][0]["skipped"] == "interval"
    # a missing secret is never due
    client.put(f"{st.base}/connectors/bindings/{st.binding}/secrets", json={"secrets": {"api_key": None}})
    assert [d.reason for d in sync.due(st.profile(), "investments", later)] == ["missing_secret"]


def test_runs_route(client, tmp_path):
    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    body = st.sync().json()
    runs = client.get(f"/api/connectors/{st.cid}/runs", params={"limit": 20}).json()
    assert runs[0]["id"] == body["run"]["run_id"] and runs[0]["profile"] == st.slug
    assert runs[0]["proposal_id"] == body["proposal_id"] and runs[0]["command"] == "fetch"
    assert set(runs[0]) >= {"started_at", "duration_ms", "outcome", "error_kind", "exit_code",
                            "records", "denied_hosts", "stderr_tail", "binding_id", "batch_ref"}
    assert client.get("/api/connectors/nope/runs").status_code == 404


# --------------------------------------------------------------------------- #
# Budget
# --------------------------------------------------------------------------- #


def test_budget_sync_proposal_approve_and_auto_commit(client, tmp_path):
    st = Setup(client, tmp_path, module="budget")
    st.set_auto(True)
    st.answer(bud_doc(bud_txn("2026-09-01", "t1"), bud_txn("2026-09-02", "t2")), cursor="b1")
    body = st.sync().json()
    assert body["module"] == "budget" and body["preview"]["new"] == 2
    pid = body["proposal_id"]
    assert pid and body["committed"] is None and bud_count(st.account) == 0
    listed = client.get(f"{st.base}/proposals", params={"status": "pending"}).json()
    assert [(p["kind"], p["summary_code"]) for p in listed] == [("budget_import", "budget_import")]
    assert listed[0]["summary_params"] == {"account": "Konto TEST", "connector": "Test fetch", "new": 2}
    detail = client.get(f"{st.base}/proposals/{pid}").json()
    assert detail["account_label"] == "Konto TEST" and detail["connector_name"] == "Test fetch"
    assert detail["preview"] == {"new": 2, "duplicates": 0, "warnings": 0}
    r = st.approve(pid)
    assert r.status_code == 200, r.text
    assert r.json()["result"]["inserted"] == 2 and r.json()["result"]["cursor_saved"] is True
    assert bud_count(st.account) == 2 and st.binding_row().cursor == "b1"
    from finanse.core.models import Source
    from finanse.modules.budget.models import Transaction

    with get_session() as s:
        sources = {t.source for t in s.exec(select(Transaction)).all()}
    assert sources == {Source.CONNECTOR}

    st.answer(bud_doc(bud_txn("2026-09-02", "t2"), bud_txn("2026-09-03", "t3")), cursor="b2")
    body = st.sync().json()
    assert body["committed"]["inserted"] == 1 and body["proposal_id"] is None
    assert bud_count(st.account) == 3 and st.binding_row().cursor == "b2"


def test_budget_resync_runs_due_bindings_without_enable_banking(client, tmp_path):
    st = Setup(client, tmp_path, module="budget")
    st.answer(bud_doc(bud_txn("2026-09-01", "t1")), cursor="b1")
    body = client.post(f"{st.base}/resync").json()
    assert body["ok"] is True and body["banks"] == []
    (line,) = body["connectors"]
    assert line["proposal_id"] and line["module"] == "budget"


def test_budget_document_for_another_account_is_a_problem(client, tmp_path):
    st = Setup(client, tmp_path, module="budget")
    doc = bud_doc(bud_txn("2026-09-01", "t1"))
    doc["account"]["iban"] = "PL61109010140000071219812874"
    with get_session() as s:
        from finanse.core.models import Account

        acc = s.get(Account, st.account)
        acc.iban = "PL27114020040000300201355387"
        s.add(acc)
    st.answer(doc, cursor="b1")
    body = st.sync().json()
    assert body["problem"]["code"] == "import_account_mismatch" and body["proposal_id"] is None


# --------------------------------------------------------------------------- #
# Worker job
# --------------------------------------------------------------------------- #


class FakeNotifier:
    name = "fake"

    def __init__(self):
        self.sent = []

    def send(self, notification):
        from finanse.core.worker.notifier import Delivery

        self.sent.append(notification)
        return Delivery(True, "fake")


def test_worker_job_syncs_due_bindings_once_and_notifies(client, tmp_path):
    from finanse.core.worker import connectors as glue

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    notifier = FakeNotifier()
    now = dt.datetime.now(dt.UTC)
    out = glue.run(st.profile(), {"investments", "budget"}, now=now, notifier=notifier)
    assert out.status == "ok" and out.stats["proposals"] == 1 and out.stats["notified"] == 1
    (n,) = notifier.sent
    assert n.subtitle == "Import czeka na zatwierdzenie" and n.message == "Test fetch: 1 nowy rekord"
    assert "100" not in n.message
    again = glue.run(st.profile(), {"investments"}, now=now, notifier=notifier)
    assert again.status == "skipped" and again.code == "connectors_not_due"
    assert glue.run(st.profile(), {"investments"}, now=now, notifier=None, offline=True).status == "skipped"
    assert glue.run(st.profile(), {"loans"}, now=now, notifier=None) is None  # module off: no row


def test_worker_job_one_failing_binding_never_stops_the_others(client, tmp_path):
    from finanse.core.worker import connectors as glue

    st = Setup(client, tmp_path)
    st.answer(error={"kind": "upstream", "message": "boom TEST"})
    second = client.post(f"{st.base}/investments/accounts",
                         json={"name": "Broker DWA", "broker": "dif", "wrapper": "regular"}).json()["id"]
    fixture2 = tmp_path / "second.json"
    fixture2.write_text(json.dumps({"document": inv_doc(deposit("2026-09-01", "x1")), "cursor": "z"}))
    r = client.post(f"{st.base}/connectors/bindings", json={
        "account_id": second, "connector_id": st.cid, "params": {"fixture": str(fixture2)},
        "secrets": {"api_key": "key-TEST"}})
    assert r.status_code == 201
    out = glue.run(st.profile(), {"investments"}, now=dt.datetime.now(dt.UTC), notifier=None)
    assert out.status == "partial" and out.stats["synced"] == 2 and out.stats["proposals"] == 1
    assert "boom" not in (out.detail or "") and "upstream" in out.detail


def test_worker_runner_records_the_job(client, tmp_path, monkeypatch):
    from finanse.core.worker import runner as worker_runner

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    monkeypatch.setattr(worker_runner, "_investments", lambda *a, **k: [])
    monkeypatch.setattr(worker_runner.inv, "backfill_prices", lambda **k: None)
    report = worker_runner.run_worker(notifier=None, budget=False, state_path=tmp_path / "state.json")
    jobs = [j for j in report.jobs if j.job == "connectors.fetch"]
    assert len(jobs) == 1 and jobs[0].status == "ok" and jobs[0].module == "core"
    assert jobs[0].stats["proposals"] == 1


def _runs(binding: int) -> int:
    with get_session() as s:
        return len(s.exec(select(ConnectorRun).where(ConnectorRun.binding_id == binding)).all())


def test_one_pending_proposal_per_binding(client, tmp_path):
    """BE-2: while a sync proposal of the binding waits, a sync runs nothing and answers
    ``pending_exists`` with that proposal; the worker skips the binding without a new notification."""
    from finanse.core.worker import connectors as glue

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    first = st.sync().json()
    pid, tried = first["proposal_id"], st.binding_row().last_run_at
    assert first["outcome"] == "synced" and pid and _runs(st.binding) == 1
    st.answer(inv_doc(deposit("2026-09-01", "d1"), deposit("2026-09-02", "d2")), cursor="c2")
    again = st.sync()
    assert again.status_code == 200, again.text
    body = again.json()
    assert (body["outcome"], body["proposal_id"], body["run"]) == ("pending_exists", pid, None)
    assert body["preview"]["new"] == 1  # the waiting proposal's preview
    assert _runs(st.binding) == 1 and st.binding_row().last_run_at == tried  # nothing ran
    later = dt.datetime.now(dt.UTC) + sync.MIN_INTERVAL + dt.timedelta(hours=1)
    notifier = FakeNotifier()
    out = glue.run(st.profile(), {"investments"}, now=later, notifier=notifier)
    assert out.status == "skipped" and notifier.sent == [] and _runs(st.binding) == 1
    with get_session() as s:
        assert len(s.exec(select(Proposal)).all()) == 1
    # once it is decided, the next sync proposes again
    assert client.post(f"{st.base}/proposals/{pid}/reject").status_code == 200
    body = st.sync().json()
    assert body["outcome"] == "synced" and body["proposal_id"] not in (None, pid)


def test_proposals_never_share_a_staged_file(client, tmp_path):
    """BE-2: two bindings fetching the same document stage two files; rejecting one proposal never
    breaks the other (was 422 staged_missing)."""
    from finanse.core import paths

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    second = client.post(f"{st.base}/investments/accounts",
                         json={"name": "Broker DWA", "broker": "dif", "wrapper": "regular"}).json()["id"]
    r = client.post(f"{st.base}/connectors/bindings", json={
        "account_id": second, "connector_id": st.cid, "params": {"fixture": str(st.fixture)},
        "secrets": {"api_key": "key-TEST"}})
    assert r.status_code == 201, r.text
    p1 = st.sync().json()["proposal_id"]
    p2 = client.post(f"{st.base}/connectors/bindings/{r.json()['id']}/sync").json()["proposal_id"]
    with get_session() as s:
        a, b = (s.get(Proposal, p).payload for p in (p1, p2))
    assert a["file_sha256"] == b["file_sha256"] and a["staged"] != b["staged"]
    assert client.post(f"{st.base}/proposals/{p1}/reject").status_code == 200
    assert not (paths.data_dir() / a["staged"]).exists() and (paths.data_dir() / b["staged"]).is_file()
    assert st.approve(p2).status_code == 200
    assert inv_count(second) == 1


def test_check_is_not_a_sync_attempt(client, tmp_path):
    """BE-4: pressing "Sprawdź" never makes the binding wait 20 h for its first scheduled sync."""
    st = Setup(client, tmp_path)
    r = client.post(f"{st.base}/connectors/bindings/{st.binding}/check")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert st.binding_row().last_run_at is None and _runs(st.binding) == 1
    assert [d.reason for d in sync.due(st.profile(), "investments", dt.datetime.now(dt.UTC))] == [None]


def test_worker_syncs_connectors_before_the_investments_daily_check(client, tmp_path, monkeypatch):
    """BE-13: a fetch binding's commit is in the same run's daily check (sync first, then the check)."""
    from finanse.core.worker import runner as worker_runner

    st = Setup(client, tmp_path)
    st.answer(inv_doc(deposit("2026-09-01", "d1")), cursor="c1")
    assert st.approve(st.sync().json()["proposal_id"]).status_code == 200
    st.set_auto(True)
    st.answer(inv_doc(deposit("2026-09-02", "d2")), cursor="c2")
    with get_session() as s:  # due again (the sync above was just now)
        row = s.get(ConnectorBinding, st.binding)
        row.last_run_at = None
        s.add(row)
    seen = []
    monkeypatch.setattr(worker_runner, "_investments",
                        lambda *a, **k: seen.append(inv_count(st.account)) or [])
    monkeypatch.setattr(worker_runner.inv, "backfill_prices", lambda **k: None)
    report = worker_runner.run_worker(notifier=None, budget=False, state_path=tmp_path / "state.json")
    (job,) = [j for j in report.jobs if j.job == "connectors.fetch"]
    assert job.stats["committed"] == 1
    assert seen == [2]  # the daily check ran after the commit
