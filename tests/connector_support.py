"""Helpers for the connector tests: a ``NoSandbox`` double, synthetic connector directories and an
in-memory keyring. All data is synthetic.

``NoSandbox`` runs the process with the same process control (clean env, process group, caps, timeouts)
but without ``sandbox-exec``. It lives here, in the tests only: production code has no unsandboxed path.
"""

from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import keyring
import pytest
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from finanse.core.connectors.process import run_process
from finanse.core.connectors.sandbox import RunOutcome, RunSpec

PYTHON3 = shutil.which("python3", path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
needs_python3 = pytest.mark.skipif(PYTHON3 is None, reason="no python3 on the fixed search path")


class NoSandbox:
    """Test double of ``ConnectorSandbox``: no confinement, same process control."""

    name = "none"

    def __init__(self) -> None:
        self.specs: list[RunSpec] = []

    def run(self, spec: RunSpec) -> RunOutcome:
        self.specs.append(spec)
        result = run_process(
            spec.argv,
            env=spec.env,
            cwd=str(spec.run_dir),
            stdin=spec.stdin,
            timeout_s=spec.timeout_s,
            max_stdout=spec.max_stdout,
        )
        if result.spawn_error:
            return RunOutcome(result, "spawn_failed", result.spawn_error, self.name)
        return RunOutcome(result, sandbox=self.name)


class MemoryKeyring(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        if self.store.pop((service, username), None) is None:
            raise PasswordDeleteError("not found")


@pytest.fixture
def memory_keyring():
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(previous)


# --------------------------------------------------------------------------- #
# Synthetic connectors
# --------------------------------------------------------------------------- #

FILE_MANIFEST = """\
api_version: 1
id: {id}
name: Test connector
version: 0.1.0
module: {module}
kind: file
run: [python3, main.py]
timeout_s: {timeout}
file:
  extensions: [csv]
"""

FETCH_MANIFEST = """\
api_version: 1
id: {id}
name: Test fetch
version: 0.1.0
module: {module}
kind: fetch
run: [python3, main.py]
timeout_s: {timeout}
fetch:
  hosts: [api.example.com]
  secrets:
    - {{id: api_key, label: Klucz API}}
  params:
    - {{id: start, label: Od daty, type: date}}
    - {{id: fixture, label: Fixture, type: string}}
  history_days: 30
"""

# A converter that answers every command from its request (synthetic investments document).
ECHO_CONNECTOR = '''\
import json, os, sys
req = json.load(sys.stdin)
cmd = req["command"]
if cmd == "detect":
    print(json.dumps({"match": True, "confidence": 0.75}))
elif cmd == "check":
    print(json.dumps({"ok": True}))
else:
    records = [
        {"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN",
         "gross_amount": "1000.00"},
        {"record": "txn", "date": "2026-01-06", "type": "buy", "symbol": "TEST", "exchange": "XWAR",
         "currency": "PLN", "quantity": "2", "price": "100.00", "gross_amount": "200.00"},
    ]
    doc = {"format": "finanse-import", "format_version": 1, "source": "test_broker", "records": records}
    out = {"document": doc}
    if cmd == "fetch":
        out["cursor"] = "c1"
    print(json.dumps(out))
'''


def write_connector(
    root: Path,
    *,
    cid: str = "test-conn",
    kind: str = "file",
    module: str = "investments",
    code: str = ECHO_CONNECTOR,
    timeout: int = 60,
    manifest: str | None = None,
    extra: dict[str, str] | None = None,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    template = FILE_MANIFEST if kind == "file" else FETCH_MANIFEST
    text = manifest if manifest is not None else template.format(id=cid, module=module, timeout=timeout)
    (root / "connector.yaml").write_text(text, encoding="utf-8")
    (root / "main.py").write_text(textwrap.dedent(code), encoding="utf-8")
    for name, content in (extra or {}).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


def target_of(root: Path):
    from finanse.core.connectors import manifest as mf
    from finanse.core.connectors.runner import RunTarget

    return RunTarget.of(mf.load_dir(root))
