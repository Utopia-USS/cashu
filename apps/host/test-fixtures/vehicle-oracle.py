"""Actual vehicle CLI bytes on an isolated synthetic database, with an injected date."""
import datetime
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

from cashu.core.paths import data_dir

assert os.environ.get("CASHU_TESTING") == "1"
assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()

from rich.console import Console
from typer.testing import CliRunner

from cashu.cli import app
from cashu.core import cliutil
from cashu.core.db import get_session, init_db
from cashu.core.profiles import create_profile

init_db()
with get_session() as session:
    create_profile(session, name="Demo", slug="demo", modules_=[])


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return cls(2026, 10, 31)


results = []
for case in json.load(sys.stdin):
    with patch.dict(os.environ, case["env"], clear=True), patch("datetime.date", FixedDate):
        cliutil.console = Console()
        cliutil.err_console = Console(stderr=True)
        result = CliRunner().invoke(app, case["args"], color=True, prog_name="cashu")
    results.append({"code": result.exit_code, "stdout": result.stdout, "stderr": result.stderr})
print(json.dumps(results, ensure_ascii=False))
