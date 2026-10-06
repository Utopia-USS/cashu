"""File connectors in the in-app imports (F10 BE-C3): investments ``connector:<id>`` and auto-detect,
the budget ``connector:<id>`` branch and auto-detect, the converted document is what is staged (the
commit never runs the connector again), the remembered importer, and the owner's 422 for a failed run
(``X-Cashu-Error-Code: connector_<kind>``, ``detail`` an object). Synthetic data, NoSandbox."""

from __future__ import annotations

import json

import pytest
from connector_support import NoSandbox, needs_python3, write_connector
from sqlmodel import select

from cashu.core.connectors import imports as connector_imports
from cashu.core.connectors import runner, service
from cashu.core.connectors.models import ConnectorRun
from cashu.core.db import get_session

pytestmark = needs_python3

FAILING = '''\
import json, sys
json.load(sys.stdin)
sys.stderr.write("row 3: column Kwota: not a number\\n")
print(json.dumps({"error": {"kind": "bad_file", "message": "row 3: unexpected column"}}))
sys.exit(1)
'''

BUDGET_CONNECTOR = '''\
import json, sys
req = json.load(sys.stdin)
if req["command"] == "detect":
    head = open(req["file"]["path"]).read(200)
    print(json.dumps({"match": head.startswith("DEMO-BANK"), "confidence": 0.9}))
    sys.exit(0)
doc = {"format": "cashu-budget-import", "format_version": 1, "source": "demo_bank",
       "account": {"currency": "PLN", "name": "Demo konto"},
       "transactions": [
           {"booking_date": "2026-09-01", "amount": "-12.50", "currency": "PLN",
            "description": "Sklep TEST", "transaction_id": "t1"},
           {"booking_date": "2026-09-02", "amount": "1000.00", "currency": "PLN",
            "description": "Wynagrodzenie TEST", "transaction_id": "t2"}]}
print(json.dumps({"document": doc}))
'''


@pytest.fixture
def sandbox(monkeypatch):
    box = NoSandbox()
    monkeypatch.setattr(runner, "default_sandbox", lambda: box)
    return box


def install_approved(client, tmp_path, cid: str, **kw) -> None:
    service.install(write_connector(tmp_path / "src" / cid, cid=cid, **kw))
    d = client.get(f"/api/connectors/{cid}").json()
    r = client.post(f"/api/connectors/{cid}/approve", json={
        "content_sha256": d["content_sha256"], "interpreter_path": d["interpreter_path"]})
    assert r.status_code == 200, r.text


def runs(cid: str) -> list[str]:
    with get_session() as s:
        rows = s.exec(
            select(ConnectorRun).where(ConnectorRun.connector_id == cid).order_by(ConnectorRun.id)
        ).all()
        return [r.command for r in rows]


# --------------------------------------------------------------------------- #
# Investments
# --------------------------------------------------------------------------- #


@pytest.fixture
def inv(api_empty, sandbox):
    r = api_empty.post("/api/profiles", json={"name": "Jan Test", "modules": ["investments"]})
    slug = r.json()["slug"]
    acc = api_empty.post(f"/api/p/{slug}/investments/accounts",
                         json={"name": "Broker TEST", "broker": "dif", "wrapper": "regular"}).json()
    return api_empty, slug, acc["id"]


def inv_preview(client, slug, account, content=b"a,b\n1,2\n", name="export.csv", importer=None):
    data = {"account_id": str(account)}
    if importer:
        data["importer"] = importer
    return client.post(f"/api/p/{slug}/investments/import/preview",
                       files={"file": (name, content, "text/csv")}, data=data)


def test_investments_connector_preview_and_commit(inv, tmp_path, sandbox):
    client, slug, account = inv
    install_approved(client, tmp_path, "test-conn")
    r = inv_preview(client, slug, account, importer="connector:test-conn")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["importer"]["id"] == "connector:test-conn" and p["importer"]["name"] == "Test connector"
    assert p["importer"]["requested"] == "connector:test-conn"
    assert p["can_commit"] and p["counts"]["new"] == 2 and p["file_name"] == "export.csv"
    request = json.loads(sandbox.specs[-1].stdin)
    assert request["account"] == {"currency": "PLN", "label": "Broker TEST"}
    assert runs("test-conn") == ["convert"]
    r = client.post(f"/api/p/{slug}/investments/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "account_id": account,
        "importer": "connector:test-conn"})
    assert r.status_code == 201, r.text
    assert r.json()["inserted"] == 2
    assert runs("test-conn") == ["convert"]  # the commit read the staged document, nothing ran
    batches = client.get(f"/api/p/{slug}/investments/imports").json()
    assert batches[0]["importer"] == "connector:test-conn"
    from cashu.modules.investments.models import InvAccountSettings

    with get_session() as s:
        assert s.get(InvAccountSettings, account).importer == "connector:test-conn"


def test_investments_auto_detects_a_connector_only_when_built_ins_do_not(inv, tmp_path):
    client, slug, account = inv
    install_approved(client, tmp_path, "test-conn")
    r = inv_preview(client, slug, account)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["importer"]["requested"] == "auto" and p["importer"]["id"] == "connector:test-conn"
    assert p["importer"]["detected"] == ["connector:test-conn"]
    assert runs("test-conn") == ["detect", "convert"]
    # a cashu-format file: the canonical importer wins, no connector runs
    canonical = (b"format_version,record,date,type,currency,gross_amount\n"
                 b"1,txn,2026-01-05,deposit,PLN,10.00\n")
    p = inv_preview(client, slug, account, content=canonical).json()
    assert p["importer"]["id"] == "cashu" and runs("test-conn") == ["detect", "convert"]
    # a connector for another extension is never asked
    p = inv_preview(client, slug, account, content=b"{}", name="x.json").json()
    assert p["can_commit"] is False and runs("test-conn") == ["detect", "convert"]


def test_auto_detect_limit_and_remembered_connector_first(inv, tmp_path, monkeypatch):
    client, slug, account = inv
    install_approved(client, tmp_path, "aaa-conn")
    install_approved(client, tmp_path, "bbb-conn")
    monkeypatch.setattr(connector_imports, "MAX_DETECT", 1)
    assert inv_preview(client, slug, account).json()["importer"]["id"] == "connector:aaa-conn"
    from cashu.modules.investments.models import InvAccountSettings

    with get_session() as s:
        row = s.get(InvAccountSettings, account)
        row.importer = "connector:bbb-conn"
        s.add(row)
    assert inv_preview(client, slug, account).json()["importer"]["id"] == "connector:bbb-conn"
    assert runs("aaa-conn").count("detect") == 1 and runs("bbb-conn").count("detect") == 1


def test_failed_connector_run_is_the_owners_422(inv, tmp_path):
    client, slug, account = inv
    install_approved(client, tmp_path, "bad-conn", code=FAILING)
    r = inv_preview(client, slug, account, importer="connector:bad-conn")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "connector_bad_file"
    d = r.json()["detail"]
    assert d["kind"] == "bad_file" and d["message"] == "row 3: unexpected column"
    assert "Kwota" in d["stderr_tail"] and d["timeout_s"] == 60
    assert d["connector"] == {"id": "bad-conn", "name": "Test connector"}
    service.install(write_connector(tmp_path / "src" / "pend-conn", cid="pend-conn"))
    r = inv_preview(client, slug, account, importer="connector:pend-conn")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "connector_not_approved"
    client.post("/api/connectors/bad-conn/disable")
    r = inv_preview(client, slug, account, importer="connector:bad-conn")
    assert r.headers["X-Cashu-Error-Code"] == "connector_disabled"
    r = inv_preview(client, slug, 99999, importer="connector:bad-conn")
    assert r.status_code == 404


def test_connector_of_the_other_module_is_refused(inv, tmp_path):
    client, slug, account = inv
    install_approved(client, tmp_path, "bud-conn", module="budget", code=BUDGET_CONNECTOR)
    r = inv_preview(client, slug, account, importer="connector:bud-conn")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "connector_bad_request"
    assert runs("bud-conn") == []


# --------------------------------------------------------------------------- #
# Budget
# --------------------------------------------------------------------------- #


@pytest.fixture
def bud(api_empty, sandbox):
    r = api_empty.post("/api/profiles", json={"name": "Jan Test", "modules": ["budget"]})
    return api_empty, r.json()["slug"]


def bud_preview(client, slug, content=b"DEMO-BANK;x\n1;2\n", name="wyciag.csv", **fields):
    return client.post(f"/api/p/{slug}/budget/import/preview",
                       files={"file": (name, content, "text/csv")},
                       data={k: str(v) for k, v in fields.items()})


def test_budget_connector_preview_and_commit(bud, tmp_path):
    from cashu.core.models import Source
    from cashu.modules.budget.models import ImportBatch, Transaction

    client, slug = bud
    install_approved(client, tmp_path, "bud-conn", module="budget", code=BUDGET_CONNECTOR)
    choices = client.get(f"/api/p/{slug}/budget/import/importers").json()["importers"]
    entry = next(c for c in choices if c["id"] == "connector:bud-conn")
    assert entry["kind"] == "connector" and entry["available"] and entry["extensions"] == ["csv"]
    r = bud_preview(client, slug, bank="connector:bud-conn")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["bank"] == {"id": "connector:bud-conn", "name": "Test connector", "detected": False}
    assert p["counts"]["new"] == 2 and p["file_name"] == "wyciag.csv"
    r = client.post(f"/api/p/{slug}/budget/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "bank": p["bank"]["id"]})
    assert r.status_code == 201, r.text
    assert r.json()["inserted"] == 2 and runs("bud-conn") == ["convert"]
    with get_session() as s:
        assert {t.source for t in s.exec(select(Transaction)).all()} == {Source.CONNECTOR}
        assert s.exec(select(ImportBatch)).one().filename == "wyciag.csv"


def test_budget_auto_detect_and_failure(bud, tmp_path):
    client, slug = bud
    install_approved(client, tmp_path, "bud-conn", module="budget", code=BUDGET_CONNECTOR)
    p = bud_preview(client, slug).json()
    assert p["bank"] == {"id": "connector:bud-conn", "name": "Test connector", "detected": True}
    assert runs("bud-conn") == ["detect", "convert"]
    # not claimed by the connector (detect says no): the old refusal
    r = bud_preview(client, slug, content=b"zupelnie;nie;wyciag\n1;2;3\n")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "import_bank_unknown"
    install_approved(client, tmp_path, "bad-conn", module="budget", code=FAILING)
    r = bud_preview(client, slug, bank="connector:bad-conn")
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "connector_bad_file"
    assert r.json()["detail"]["connector"]["id"] == "bad-conn"
    from cashu.core import paths

    staged = list((paths.data_dir() / "imports" / slug / ".staging").glob("budget-*"))
    assert len(staged) == 1  # the earlier detected preview; the failed upload is not kept


EXACT_CONNECTOR = """\
import json, sys
req = json.load(sys.stdin)
if req["command"] == "detect":
    print(json.dumps({"match": True, "confidence": 0.9}))
    sys.exit(0)
print('{"document": {"format": "cashu-import", "format_version": 1, "source": "test_broker", '
      '"records": [{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN", '
      '"gross_amount": 1000.00}, {"record": "txn", "date": "2026-01-06", "type": "buy", '
      '"symbol": "TEST", "exchange": "XWAR", "currency": "PLN", "quantity": 0.123456789012345678, '
      '"price": 100.00, "gross_amount": 12.35}]}}')
"""


def test_connector_quantity_with_18_decimals_is_imported_exactly(inv, tmp_path):
    """BE-6: the document reaches the importer with exact decimals (no float round trip)."""
    from decimal import Decimal

    from cashu.modules.investments.models import InvTransaction

    client, slug, account = inv
    install_approved(client, tmp_path, "test-conn", code=EXACT_CONNECTOR)
    p = inv_preview(client, slug, account, importer="connector:test-conn").json()
    assert p["can_commit"], p
    r = client.post(f"/api/p/{slug}/investments/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "account_id": account,
        "importer": "connector:test-conn"})
    assert r.status_code == 201, r.text
    with get_session() as s:
        quantities = [t.quantity for t in s.exec(select(InvTransaction)).all() if t.quantity]
    assert quantities == [Decimal("0.123456789012345678")]


# The three statement rows of CSV_3 again, as a bank API / converter writes them (other memo texts).
OVERLAP_CONNECTOR = '''\
import json, sys
req = json.load(sys.stdin)
if req["command"] == "detect":
    print(json.dumps({"match": True, "confidence": 0.9}))
    sys.exit(0)
rows = [("2026-09-01", "9000.00"), ("2026-09-03", "-120.50"), ("2026-09-05", "-3000.00")]
doc = {"format": "cashu-budget-import", "format_version": 1, "source": "demo_api",
       "account": {"currency": "PLN", "iban": "PL99114000000000000000000101"},
       "transactions": [{"booking_date": d, "amount": a, "currency": "PLN",
                         "description": "API TEXT " + d} for d, a in rows]}
print(json.dumps({"document": doc}))
'''

CSV_3 = """mBank S.A.
#Numer rachunku
99 1140 0000 0000 0000 0000 0101
#Waluta
PLN
#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji
2026-09-01;PRZELEW PRZYCHODZACY;WYNAGRODZENIE TEST;PRACODAWCA TEST;;9 000,00;9 500,00
2026-09-03;ZAKUP PRZY UZYCIU KARTY;BIEDRONKA TEST;BIEDRONKA TEST;;-120,50;9 379,50
2026-09-05;PRZELEW WYCHODZACY;RATA TEST;BANK TEST;;-3 000,00;6 379,50
""".encode("cp1250")


def test_budget_connector_rows_do_not_double_csv_rows(bud, tmp_path):
    """BE-1: 3 rows from the bank CSV, then the same 3 from a connector (other texts): new 0."""
    from cashu.modules.budget.models import Transaction

    client, slug = bud
    p = bud_preview(client, slug, content=CSV_3).json()
    r = client.post(f"/api/p/{slug}/budget/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "bank": "mbank"})
    assert r.status_code == 201 and r.json()["inserted"] == 3
    install_approved(client, tmp_path, "bud-conn", module="budget", code=OVERLAP_CONNECTOR)
    p = bud_preview(client, slug, bank="connector:bud-conn").json()
    assert p["account"]["existing"] is True
    assert (p["counts"]["new"], p["counts"]["duplicates"], p["counts"]["overlap"]) == (0, 3, 3)
    assert [w["code"] for w in p["warnings"]] == ["import.overlap"]
    assert {row["status"] for row in p["rows"]} == {"duplicate"} and all(r["overlap"] for r in p["rows"])
    r = client.post(f"/api/p/{slug}/budget/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "bank": p["bank"]["id"]})
    assert r.status_code == 201 and (r.json()["inserted"], r.json()["duplicates"]) == (0, 3)
    with get_session() as s:
        assert len(s.exec(select(Transaction)).all()) == 3


def test_budget_connector_rows_do_not_double_open_banking_rows(bud, tmp_path):
    """BE-1, Open Banking variant: the same 3 transactions stored from Enable Banking."""
    from datetime import date
    from decimal import Decimal

    from cashu.core import profiles
    from cashu.core.accounts import get_or_create_account
    from cashu.core.models import Source
    from cashu.modules.budget.ingestion.normalize import RawTransaction
    from cashu.modules.budget.service import ingest_transactions

    client, slug = bud
    with get_session() as s:
        pid = profiles.get_by_slug(s, slug).id
        acc = get_or_create_account(s, bank="mbank", iban="99114000000000000000000101", profile_id=pid)
        ingest_transactions(s, acc, [
            RawTransaction(booking_date=date(2026, 9, d), amount=Decimal(a), reference=f"OB TEST {d}",
                           bank_transaction_id=f"eb-{d}", source=Source.OPEN_BANKING)
            for d, a in ((1, "9000.00"), (3, "-120.50"), (5, "-3000.00"))
        ], source=Source.OPEN_BANKING, newest_day_rule=True)
        account_id = acc.id
    install_approved(client, tmp_path, "bud-conn", module="budget", code=OVERLAP_CONNECTOR)
    p = bud_preview(client, slug, bank="connector:bud-conn", account_id=account_id).json()
    assert (p["counts"]["new"], p["counts"]["overlap"]) == (0, 3)


def test_budget_remembers_the_connector_per_account(bud, tmp_path, monkeypatch):
    """BE-5: ``auto`` asks the account's last connector first (a tie no longer goes by id order)."""
    from cashu.core import profiles
    from cashu.core.accounts import get_or_create_account

    client, slug = bud
    with get_session() as s:
        pid = profiles.get_by_slug(s, slug).id
        account_id = get_or_create_account(s, bank="mbank", name="Konto TEST", profile_id=pid).id
    install_approved(client, tmp_path, "aaa-conn", module="budget", code=BUDGET_CONNECTOR)
    install_approved(client, tmp_path, "bbb-conn", module="budget", code=BUDGET_CONNECTOR)
    p = bud_preview(client, slug, account_id=account_id).json()
    assert p["bank"]["id"] == "connector:aaa-conn" and p["account"]["remembered_importer"] is None
    p = bud_preview(client, slug, bank="connector:bbb-conn", account_id=account_id).json()
    r = client.post(f"/api/p/{slug}/budget/import/commit", json={
        "file_id": p["file_id"], "file_name": p["file_name"], "bank": p["bank"]["id"],
        "account_id": account_id})
    assert r.status_code == 201, r.text
    monkeypatch.setattr(connector_imports, "MAX_DETECT", 1)
    p = bud_preview(client, slug, account_id=account_id).json()
    assert p["bank"] == {"id": "connector:bbb-conn", "name": "Test connector", "detected": True}
    assert p["account"]["remembered_importer"] == "connector:bbb-conn"
