"""Actual Python budget cash CLI bytes on one isolated synthetic profile."""
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
from cashu.modules.investments.service import files

payload = json.load(sys.stdin)
cases = payload if isinstance(payload, list) else payload["cases"]
modules = ["budget"] if isinstance(payload, list) else payload["modules"]
init_db()
with get_session() as session:
    create_profile(session, name="Demo", slug="demo", modules_=modules)


results = []
for case in cases:
    if "strategy_yaml" in case:
        path = files.strategy_yaml_path("demo")
        if case["strategy_yaml"] is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(case["strategy_yaml"], encoding="utf-8")
    with patch.dict(os.environ, case["env"], clear=True):
        cliutil.console = Console()
        cliutil.err_console = Console(stderr=True)
        result = CliRunner().invoke(app, case["args"], color=True, prog_name="cashu")
    results.append({"code": result.exit_code, "stdout": result.stdout, "stderr": result.stderr})
print(json.dumps(results, ensure_ascii=False))
