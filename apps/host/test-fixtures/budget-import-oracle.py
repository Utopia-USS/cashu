"""Actual budget import/category CLI bytes and state, isolated synthetic inputs only."""

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

from cashu.core.paths import data_dir

assert os.environ.get("CASHU_TESTING") == "1"
assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()

from rich.console import Console
from sqlmodel import select
from typer.testing import CliRunner

from cashu.cli import app
from cashu.core import cliutil
from cashu.core.db import get_session, init_db
from cashu.core.models import Account
from cashu.core.profiles import create_profile
from cashu.modules.budget.models import ImportBatch, Transaction

init_db()
with get_session() as session:
    profile = create_profile(session, name="Demo", slug="demo", modules_=["budget"])
    pid = profile.id

results = []
for case in json.load(sys.stdin):
    with patch.dict(os.environ, case["env"], clear=True):
        os.chdir(case["cwd"])
        cliutil.console = Console()
        cliutil.err_console = Console(stderr=True)
        result = CliRunner().invoke(app, case["args"], color=True, prog_name="cashu")
    with get_session() as session:
        accounts = list(session.exec(select(Account).where(Account.profile_id == pid)).all())
        by_id = {a.id: a for a in accounts}
        rows = []
        for txn in session.exec(select(Transaction).where(Transaction.account_id.in_(by_id))).all():
            account = by_id[txn.account_id]
            row = {
                "bank": account.bank,
                "account": account.name,
                "type": account.type,
                "date": txn.booking_date.isoformat(),
                "amount": format(txn.amount, ".2f"),
                "currency": txn.currency,
                "counterparty": txn.counterparty_name,
                "description": txn.description,
                "reference": txn.reference,
            }
            if case.get("categories"):
                row.update(category=txn.category, source=txn.category_source)
            rows.append(row)
        batches = [
            [b.num_seen, b.num_inserted, b.num_duplicates]
            for b in session.exec(
                select(ImportBatch).where(ImportBatch.profile_id == pid).order_by(ImportBatch.id)
            ).all()
        ]
    results.append(
        {
            "code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "rows": rows,
            "batches": batches,
        }
    )
print(json.dumps(results, ensure_ascii=False))
