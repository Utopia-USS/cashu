"""Actual local-classifier CLI, synthetic transactions and a loopback mock model only."""

import datetime
import json
import os
import re
import sys
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from cashu.core.paths import data_dir

assert os.environ.get("CASHU_TESTING") == "1"
assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()
request = json.load(sys.stdin)
requests = []
mode = "answers"


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        requests.append(body)
        listing = body["messages"][1]["content"]
        ids = re.findall(r"(?m)^(m\d+):|^\[(t\d+)\]", listing)
        keys = [a or b for a, b in ids]
        if mode == "empty":
            keys = []
        content = json.dumps(
            {"results": [{"id": k, "category": "shopping", "confidence": 0.8} for k in keys]}
        )
        if mode == "malformed":
            content = "{"
        payload = json.dumps({"message": {"content": content}}).encode()
        self.send_response(503 if mode == "http503" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
os.environ["CASHU_CATEGORIZE_OLLAMA_URL"] = f"http://127.0.0.1:{server.server_port}"
os.environ["CASHU_CATEGORIZE_OLLAMA_MODEL"] = "synthetic-default"
os.environ["CASHU_CATEGORIZE_LLM_BACKEND"] = "ollama"

from rich.console import Console
from sqlmodel import select
from typer.testing import CliRunner

from cashu.cli import app
from cashu.core import cliutil
from cashu.core.db import get_session, init_db
from cashu.core.profiles import create_profile
from cashu.modules.budget.ingestion.csv_import.base import ParsedStatement
from cashu.modules.budget.ingestion.normalize import RawTransaction
from cashu.modules.budget.models import Transaction
from cashu.modules.budget.service import categorize_all, import_statement
from cashu.modules.loans.service import add_loan

init_db()
with get_session() as session:
    profile = create_profile(session, name="Demo", slug="demo", modules_=["budget"])
    pid = profile.id
    rows = [
        RawTransaction(
            booking_date=datetime.date.fromisoformat(r["date"]),
            amount=Decimal(r["amount"]),
            currency="PLN",
            counterparty_name=r["merchant"],
            description=r["description"],
            reference=r["reference"],
            bank_transaction_id=str(i),
            source="csv",
        )
        for i, r in enumerate(request["rows"])
    ]
    import_statement(
        session,
        ParsedStatement(
            bank="mbank", account_number=None, account_name="Synthetic", transactions=rows
        ),
        profile_id=pid,
    )
    add_loan(
        session,
        name="Synthetic loan",
        principal="100",
        annual_rate="0",
        term_months=12,
        start_date=datetime.date(2026, 9, 1),
        payment_text="OWNER PAYMENT MARKER",
        profile_id=pid,
    )
    categorize_all(session, profile_id=pid)


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return cls(2026, 10, 1)


results = []
try:
    for case in request["cases"]:
        mode = case.get("mode", "answers")
        requests.clear()
        env = {**os.environ, **case.get("env", {})}
        with patch.dict(os.environ, env, clear=True), patch("datetime.date", FixedDate):
            cliutil.console = Console()
            cliutil.err_console = Console(stderr=True)
            result = CliRunner().invoke(
                app, ["-p", "demo", *case["args"]], color=True, prog_name="cashu"
            )
        with get_session() as session:
            state = [
                [t.bank_transaction_id, t.category, t.category_source]
                for t in session.exec(select(Transaction).order_by(Transaction.id)).all()
            ]
        results.append(
            {
                "code": result.exit_code,
                # CliRunner.stdout normalizes CRLF, losing the progress carriage-return byte.
                "stdout": result.stdout_bytes.decode("utf-8"),
                "stderr": result.stderr_bytes.decode("utf-8"),
                "state": state,
                "requests": list(requests),
                "endpoint": os.environ["CASHU_CATEGORIZE_OLLAMA_URL"],
            }
        )
finally:
    server.shutdown()
    server.server_close()
print(json.dumps(results, ensure_ascii=False))
