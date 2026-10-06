"""`finanse connectors add|list|show|remove|disable|test|secret set` (F10). There is no `approve`
command. `test` prints a value-free report. Synthetic data, NoSandbox unless the real macOS sandbox is
the point of the test."""

from __future__ import annotations

import json
import os
import sys

import pytest
from connector_support import (  # noqa: F401  (fixture)
    NoSandbox,
    memory_keyring,
    needs_python3,
    write_connector,
)
from rich.console import Console
from sqlmodel import select
from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import cliutil, secrets
from finanse.core.connectors import devtest, runner, service
from finanse.core.connectors.models import Connector, ConnectorRun
from finanse.core.db import get_session

pytestmark = needs_python3

# A synthetic value that must never appear in a report (it is in the export and the document).
MARKER_SYMBOL = "ZZQX"
MARKER_PRICE = "4321.98"


@pytest.fixture
def run(monkeypatch, db_engine, memory_keyring):  # noqa: F811
    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=220, color_system=None, stderr=True))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    monkeypatch.setattr(runner, "default_sandbox", lambda: NoSandbox())
    cli = CliRunner()

    def invoke(*args, input=None):
        return cli.invoke(cli_mod.app, list(args), input=input, catch_exceptions=False)

    return invoke


def test_no_approve_command(run):
    from finanse.core.connectors.cli import connectors_app, secret_app

    names = {c.name for c in connectors_app.registered_commands}
    assert names == {"add", "list", "show", "disable", "remove", "test"}
    assert {c.name for c in secret_app.registered_commands} == {"set"}
    assert run("connectors", "--help").exit_code == 0
    assert run("connectors", "approve", "x").exit_code != 0


def test_add_list_show_disable_remove(run, tmp_path):
    src = write_connector(tmp_path / "src")
    added = run("connectors", "add", str(src))
    assert added.exit_code == 0, added.output
    assert "status pending" in added.output and "Ustawienia > Konektory" in added.output
    assert run("connectors", "add", str(src)).exit_code == 1  # already installed
    assert run("connectors", "add", str(src), "--replace").exit_code == 0

    listed = run("connectors", "list")
    assert "test-conn" in listed.output and "pending" in listed.output
    shown = run("connectors", "show", "test-conn")
    assert shown.exit_code == 0 and "main.py" in shown.output and "content sha256" in shown.output
    assert run("connectors", "show", "nope").exit_code == 1

    assert run("connectors", "disable", "test-conn").exit_code == 0
    with get_session() as s:
        assert s.get(Connector, "test-conn").status == "disabled"
    assert run("connectors", "remove", "test-conn", input="n\n").exit_code == 1
    removed = run("connectors", "remove", "test-conn", "--yes")
    assert removed.exit_code == 0 and "removed" in removed.output
    assert not (service.connectors_root() / "test-conn").exists()


def test_add_reports_every_manifest_problem(run, tmp_path):
    bad = write_connector(tmp_path / "bad", manifest=(
        "api_version: 1\nid: bad-one\nname: x\nversion: '1'\nmodule: investments\nkind: file\n"
        "run: [bash, x.sh]\nfile: {extensions: [csv]}\ntimout_s: 5\n"))
    result = run("connectors", "add", str(bad))
    assert result.exit_code == 1
    assert "not an allowed interpreter" in result.output
    assert 'did you mean "timeout_s"' in result.output


INVESTMENTS_CONVERTER = f'''\
import csv, json, sys
req = json.load(sys.stdin)
if req["command"] == "detect":
    print(json.dumps({{"match": True, "confidence": 0.9}}))
    sys.exit(0)
rows = list(csv.DictReader(open(req["file"]["path"], encoding="utf-8")))
records = []
for row in rows:
    records.append({{"record": "txn", "date": row["date"], "type": row["type"], "currency": "PLN",
                    "symbol": row["symbol"], "exchange": "XWAR", "quantity": row["qty"],
                    "price": row["price"], "gross_amount": row["gross"]}})
records.append({{"record": "txn", "date": "2026-01-02", "type": "deposit", "currency": "PLN",
                "gross_amount": "{MARKER_PRICE}"}})
print(json.dumps({{"document": {{"format": "finanse-import", "format_version": 1, "source": "test_csv",
                                 "records": records}}}}))
'''


def _export(tmp_path):
    path = tmp_path / "export.csv"
    path.write_text(
        "date,type,symbol,qty,price,gross\n"
        f"2026-01-05,buy,{MARKER_SYMBOL},2,{MARKER_PRICE},8643.96\n"
        f"2026-01-06,sell,{MARKER_SYMBOL},1,{MARKER_PRICE},4321.98\n"
        f"2026-01-07,buy,{MARKER_SYMBOL},x,{MARKER_PRICE},1\n",
        encoding="utf-8",
    )
    return path


def test_test_prints_a_value_free_report(run, tmp_path):
    src = write_connector(tmp_path / "src", code=INVESTMENTS_CONVERTER)
    result = run("connectors", "test", str(src), "--file", str(_export(tmp_path)))
    out = result.output
    assert "manifest: OK" in out and "detect: ok" in out and "match: yes (confidence 0.90)" in out
    assert "convert: ok" in out and "document: INVALID (finanse-import)" in out
    assert "transactions:" in out and "buy" in out
    assert "invalid_value" in out and "fields quantity" in out
    assert result.exit_code == 1  # the invalid quantity blocks
    assert MARKER_SYMBOL not in out and MARKER_PRICE not in out and "8643" not in out
    with get_session() as s:
        runs = s.exec(select(ConnectorRun)).all()
    assert [(r.command, r.outcome, r.profile_id) for r in runs] == [
        ("detect", "ok", None), ("convert", "ok", None)]


def test_test_ok_and_check_manifest(run, tmp_path):
    src = write_connector(tmp_path / "src")
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    ok = run("connectors", "test", str(src), "--file", str(export), "--module", "investments")
    assert ok.exit_code == 0, ok.output
    assert "document: OK (finanse-import)" in ok.output
    assert "transactions: 2 (buy 1, deposit 1)" in ok.output
    only = run("connectors", "test", str(src), "--check-manifest")
    assert only.exit_code == 0 and "manifest: OK" in only.output and "detect" not in only.output
    wrong = run("connectors", "test", str(src), "--file", str(export), "--module", "budget")
    assert wrong.exit_code == 1 and "module" in wrong.output
    fixture_for_file = run("connectors", "test", str(src), "--fixture", str(export))
    assert fixture_for_file.exit_code == 1 and "--file" in fixture_for_file.output


def test_test_failure_prints_kind_not_data(run, tmp_path):
    code = (
        "import json, sys\njson.load(sys.stdin)\n"
        f"sys.stderr.write('row {MARKER_SYMBOL} {MARKER_PRICE}')\n"
        f"print(json.dumps({{'error': {{'kind': 'bad_file', 'message': 'bad value \"{MARKER_SYMBOL}\" "
        f"at row 3: {MARKER_PRICE}'}}}}))\nsys.exit(1)\n"
    )
    src = write_connector(tmp_path / "src", code=code)
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    result = run("connectors", "test", str(src), "--file", str(export))
    assert result.exit_code == 1
    assert "convert: failed [bad_file]" in result.output and "row 3" in result.output
    assert MARKER_SYMBOL not in result.output and MARKER_PRICE not in result.output


FETCH_FROM_FIXTURE = '''\
import json, sys
req = json.load(sys.stdin)
assert req["secrets"] == {"api_key": "test-not-a-real-secret"}
data = json.loads(req["params"]["fixture"])
records = [{"record": "txn", "date": d["day"], "type": "deposit", "currency": "PLN",
            "gross_amount": d["amount"]} for d in data["items"]]
print(json.dumps({"document": {"format": "finanse-import", "format_version": 1, "records": records},
                  "cursor": "next-page"}))
'''


def test_test_fetch_runs_offline_with_a_fixture(run, tmp_path):
    src = write_connector(tmp_path / "src", cid="test-fetch", kind="fetch", code=FETCH_FROM_FIXTURE)
    fixture = tmp_path / "fixture.json"
    fixture.write_text(json.dumps({"items": [{"day": "2026-03-01", "amount": MARKER_PRICE}]}))
    result = run("connectors", "test", str(src), "--fixture", str(fixture))
    assert result.exit_code == 0, result.output
    assert "fetch: ok" in result.output and "(offline, fixture)" in result.output
    assert "cursor: 9 characters" in result.output and "deposit 1" in result.output
    assert MARKER_PRICE not in result.output
    no_fixture = run("connectors", "test", str(src))
    assert no_fixture.exit_code == 1 and "--fixture" in no_fixture.output


def test_test_budget_document_without_the_validator(run, tmp_path, monkeypatch):
    monkeypatch.setattr(devtest, "budget_validator", lambda: None)
    code = (
        "import json, sys\nreq = json.load(sys.stdin)\n"
        "if req['command'] == 'detect':\n    print(json.dumps({'match': False, 'confidence': 0}))\n"
        "else:\n    print(json.dumps({'document': {'format': 'finanse-budget-import', "
        "'format_version': 1, 'account': {'currency': 'PLN'}, 'transactions': [{}, {}]}}))\n"
    )
    src = write_connector(tmp_path / "src", module="budget", code=code)
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    result = run("connectors", "test", str(src), "--file", str(export))
    assert result.exit_code == 0, result.output
    assert "document: shape OK (finanse-budget-import)" in result.output
    assert "transactions: 2, balances: 0" in result.output
    assert "budget validation not available yet" in result.output


def test_test_budget_document_with_the_real_validator(run, tmp_path):
    if devtest.budget_validator() is None:
        pytest.skip("the budget module does not provide validate_budget_document yet")
    code = (
        "import json, sys\nreq = json.load(sys.stdin)\n"
        "doc = {'format': 'finanse-budget-import', 'format_version': 1, 'source': 'test_bank',\n"
        "       'account': {'currency': 'PLN'}, 'transactions': [\n"
        "         {'booking_date': '2026-03-01', 'amount': '-12.50', 'currency': 'PLN',\n"
        "          'counterparty_name': 'SKLEP ZZQX'}]}\n"
        "print(json.dumps({'match': True}) if req['command'] == 'detect' else "
        "json.dumps({'document': doc}))\n"
    )
    src = write_connector(tmp_path / "src", module="budget", code=code)
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    result = run("connectors", "test", str(src), "--file", str(export))
    assert result.exit_code == 0, result.output
    assert "document: OK (finanse-budget-import)" in result.output
    assert MARKER_SYMBOL not in result.output and "12.50" not in result.output


def test_test_budget_document_uses_the_hook_when_present(run, tmp_path, monkeypatch):
    class Report:
        ok = False

        def summary(self):
            return "transactions: 2\nerror invalid_value: rows 1"

    seen = []
    monkeypatch.setattr(devtest, "budget_validator", lambda: lambda data, name: seen.append(data) or Report())
    code = (
        "import json, sys\nreq = json.load(sys.stdin)\n"
        "print(json.dumps({'match': True}) if req['command'] == 'detect' else "
        "json.dumps({'document': {'format': 'finanse-budget-import', 'transactions': []}}))\n"
    )
    src = write_connector(tmp_path / "src", module="budget", code=code)
    export = tmp_path / "e.csv"
    export.write_text("a\n", encoding="utf-8")
    result = run("connectors", "test", str(src), "--file", str(export))
    assert result.exit_code == 1
    assert "document: INVALID (finanse-budget-import)" in result.output
    assert "  error invalid_value: rows 1" in result.output
    assert json.loads(seen[0])["format"] == "finanse-budget-import"


def test_secret_set_uses_hidden_input_never_argv(run, tmp_path, memory_keyring):  # noqa: F811
    from finanse.core import profiles
    from finanse.core.accounts import get_or_create_account

    with get_session() as s:
        profile = profiles.create_profile(s, name="Jan Test", modules_=["investments"])
        account = get_or_create_account(
            s, bank="dif", name="Broker TEST", type="brokerage", profile_id=profile.id
        )
        account_id = account.id
    src = write_connector(tmp_path / "src", cid="test-fetch", kind="fetch")
    installed = service.install(src).connector
    service.approve("test-fetch", installed.content_sha256, installed.interpreter_path)
    binding = service.create_binding(profile, account_id=account_id, connector_id="test-fetch")
    result = run("--profile", profile.slug, "connectors", "secret", "set", str(binding["id"]), "api_key",
                 input="s3cret-TEST\n")
    assert result.exit_code == 0, result.output
    assert "s3cret" not in result.output
    name = secrets.connector_secret_name("test-fetch", profile.slug, binding["id"], "api_key")
    assert memory_keyring.store[("finanse", name)] == "s3cret-TEST"
    assert run("--profile", profile.slug, "connectors", "secret", "set", "999", "api_key",
               input="x\n").exit_code == 1
    assert run("--profile", profile.slug, "connectors", "secret", "set", str(binding["id"]), "nope",
               input="x\n").exit_code == 1


@pytest.mark.skipif(sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"),
                    reason="macOS sandbox-exec only")
def test_test_runs_in_the_real_sandbox(run, tmp_path, monkeypatch):
    from finanse.core.connectors.sandbox import MacSandbox

    monkeypatch.setattr(runner, "default_sandbox", lambda: MacSandbox())
    src = write_connector(tmp_path / "src", code=INVESTMENTS_CONVERTER)
    result = run("connectors", "test", str(src), "--file", str(_export(tmp_path)))
    assert "convert: ok" in result.output, result.output
    assert MARKER_SYMBOL not in result.output


def test_value_free_strips_names_ibans_and_emails():
    """BE-7: a failed run's message printed by ``connectors test`` (the agent may read it)."""
    from finanse.core.connectors.devtest import value_free

    out = value_free(
        "row 7: bad account PL61109010140000071219812874 of Jan Kowalski, kwota 4321.09, "
        "mail jan.kowalski@x.pl, ANNA NOWAK-TEST paid; column 3 'x'"
    )
    for leak in ("PL61", "1090", "Kowalski", "jan.kowalski", "4321", "ANNA", "NOWAK"):
        assert leak not in out, (leak, out)
    assert out.startswith("row 7: bad account") and "column 3" in out and "<name>" in out
