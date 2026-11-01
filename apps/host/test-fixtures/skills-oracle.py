"""Synthetic-only oracle for the native skills CLI. One process amortizes Python imports."""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

from cashu.core.paths import data_dir

assert os.environ.get("CASHU_TESTING") == "1"
assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()

import typer
from rich.console import Console
from typer.testing import CliRunner

from cashu.core import cliutil
from cashu.desktop import cli

app = typer.Typer()
app.add_typer(cli.skills_app, name="skills")
results = []
for case in json.load(sys.stdin):
    os.chdir(case["cwd"])
    if case.get("edit"):
        Path(case["edit"]).write_text("synthetic owner edit\n")
    cli.runtime.skills_dir = lambda: Path(case["source"]) if case["source"] else None
    with patch.dict(os.environ, case["env"], clear=True):
        cliutil.console = Console()
        cliutil.err_console = Console(stderr=True)
        result = CliRunner().invoke(app, ["skills", *case["args"]], color=True, prog_name="cashu")
    results.append({"code": result.exit_code, "stdout": result.stdout, "stderr": result.stderr})
print(json.dumps(results, ensure_ascii=False))
