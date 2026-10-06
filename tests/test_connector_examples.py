"""The example connectors in `examples/connectors/` pass `finanse connectors test` (F10 DOC-C).

docs/connectors.md points outside authors at these examples, so they must keep working: with the real
macOS sandbox (the way the app runs them) and, on every platform, with the tests' NoSandbox double.
The samples and the fixture are synthetic; the report must never echo their values.
"""

from __future__ import annotations

import os
import sys

import pytest
from connector_support import NoSandbox, needs_python3
from rich.console import Console
from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import cliutil, paths
from finanse.core.connectors import manifest as mf
from finanse.core.connectors import runner

pytestmark = needs_python3

EXAMPLES = paths.PROJECT_ROOT / "examples" / "connectors"
# (directory, test option, input file, lines the report must contain)
CASES = [
    ("budget-csv-example", "--file", "sample.csv",
     ["detect: ok", "match: yes", "convert: ok", "document: OK (finanse-budget-import)",
      "4 transactions"]),
    ("investments-json-example", "--file", "sample.json",
     ["detect: ok", "match: yes", "convert: ok", "document: OK (finanse-import)",
      "transactions: 6 (buy 2, deposit 1, dividend 1, fee 1, sell 1)", "positions: 2",
      "errors: 0, warnings: 0"]),
    ("fetch-example", "--fixture", "fixture.json",
     ["fetch: ok", "(offline, fixture)", "cursor: 6 characters", "document: OK (finanse-import)",
      "transactions: 4 (buy 2, deposit 1, sell 1)", "errors: 0, warnings: 0"]),
]
# Synthetic values from the inputs that a value-free report must not contain.
VALUES = ["PL99", "9 000,00", "-139", "TX-0001", "KLUB", "PLTEST000010", "9543.82", "OP-1002",
          "40000", "E-1004", "BTC"]

real_sandbox = pytest.mark.skipif(
    sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"),
    reason="macOS sandbox-exec only",
)


@pytest.fixture
def run(monkeypatch, db_engine):
    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=220, color_system=None, stderr=True))
    cli = CliRunner()

    def invoke(*args):
        return cli.invoke(cli_mod.app, list(args), catch_exceptions=False)

    return invoke


def _check(run, name, option, input_name, expected):
    directory = EXAMPLES / name
    result = run("connectors", "test", str(directory), option, str(directory / input_name))
    assert result.exit_code == 0, result.output
    for line in expected:
        assert line in result.output, result.output
    report = "\n".join(  # the hash and the interpreter path are not from the input
        line for line in result.output.splitlines()
        if not line.strip().startswith(("content sha256:", "interpreter:"))
    )
    for value in VALUES:
        assert value not in report, value


@pytest.mark.parametrize(("name", "option", "input_name", "expected"), CASES)
def test_example_passes_without_the_sandbox(run, monkeypatch, name, option, input_name, expected):
    monkeypatch.setattr(runner, "default_sandbox", lambda: NoSandbox())
    _check(run, name, option, input_name, expected)


@real_sandbox
@pytest.mark.parametrize(("name", "option", "input_name", "expected"), CASES)
def test_example_passes_in_the_real_sandbox(run, monkeypatch, name, option, input_name, expected):
    from finanse.core.connectors.sandbox import MacSandbox

    monkeypatch.setattr(runner, "default_sandbox", lambda: MacSandbox())
    _check(run, name, option, input_name, expected)


def test_examples_are_valid_connector_dirs():
    names = sorted(p.name for p in EXAMPLES.iterdir() if p.is_dir())
    assert names == sorted(c[0] for c in CASES)
    for name in names:
        loaded = mf.load_dir(EXAMPLES / name)
        assert loaded.manifest.id == name
        assert loaded.manifest.run[0] == "python3"
        # The fixture param is passed only by `connectors test`: a binding can never set it.
        if loaded.manifest.fetch:
            assert "fixture" not in {p.id for p in loaded.manifest.fetch.params}
        readme = (EXAMPLES / name / "README.md").read_text(encoding="utf-8")
        assert len(readme.splitlines()) <= 10
        assert "\u2014" not in readme  # no em dash
