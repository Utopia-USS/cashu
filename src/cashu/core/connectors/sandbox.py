"""The ``ConnectorSandbox`` seam: how one connector process is started.

- :class:`MacSandbox` runs ``/usr/bin/sandbox-exec -p <profile> <argv>`` with a deny-default SBPL profile
  rendered from the package data file ``sandbox.sb`` (read: system, connector dir, interpreter
  installation, run dir; write: run dir; network: none, or only the egress proxy port for fetch runs).
- :class:`UnsupportedSandbox` (every other platform): nothing runs, every run fails with
  ``sandbox_unavailable``. There is no unsandboxed fallback in production code; tests inject their own
  double (tests/connector_support.py ``NoSandbox``).

Both go through :func:`process.run_process` (clean env, process group, caps, timeouts).
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from string import Template
from typing import Protocol, runtime_checkable

from . import manifest as mf
from .process import ProcessResult, run_process

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
PROFILE_TEMPLATE = "sandbox.sb"
SANDBOX_UNAVAILABLE_PL = "Konektory działają tylko w aplikacji na macOS (brak piaskownicy)."


@dataclass(frozen=True, slots=True)
class RunSpec:
    """One process start: the resolved argv and everything the sandbox needs to confine it."""

    argv: tuple[str, ...]
    connector_dir: Path
    interpreter: Path
    run_dir: Path
    env: Mapping[str, str]
    stdin: bytes
    timeout_s: float
    max_stdout: int
    proxy_port: int | None = None  # fetch runs: the egress proxy; None = no network at all


@dataclass(frozen=True, slots=True)
class RunOutcome:
    """What the sandbox reports back. ``error_kind`` is set when nothing could run."""

    process: ProcessResult | None = None
    error_kind: str | None = None
    message: str | None = None
    sandbox: str = ""
    extra: dict = field(default_factory=dict)


@runtime_checkable
class ConnectorSandbox(Protocol):
    name: str

    def run(self, spec: RunSpec) -> RunOutcome: ...


# --------------------------------------------------------------------------- #
# macOS
# --------------------------------------------------------------------------- #


def sbpl_string(path: str | Path) -> str:
    """A path as an SBPL string literal (backslash and double quote escaped, no control characters)."""
    text = str(path)
    if any(ord(ch) < 32 for ch in text):
        raise ValueError("control characters in a sandbox path")
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _real(path: Path) -> str:
    return os.path.realpath(path)


def _ancestors(path: str) -> list[str]:
    out = []
    current = os.path.dirname(path)
    while current and current != "/":
        out.append(current)
        current = os.path.dirname(current)
    return out


def render_profile(spec: RunSpec) -> str:
    """The SBPL profile for ``spec`` (paths resolved to real paths: the kernel checks those)."""
    connector = _real(spec.connector_dir)
    run_dir = _real(spec.run_dir)
    interpreter = _real(spec.interpreter)
    prefix = mf.interpreter_prefix(Path(interpreter))
    prefix_s = _real(prefix) if prefix is not None else None

    exec_rules = [f"(literal {sbpl_string(interpreter)})", f"(subpath {sbpl_string(connector)})"]
    read_rules = [
        f"(subpath {sbpl_string(connector)})",
        f"(subpath {sbpl_string(run_dir)})",
        f"(literal {sbpl_string(interpreter)})",
    ]
    if prefix_s:
        exec_rules.append(f"(subpath {sbpl_string(prefix_s)})")
        read_rules.append(f"(subpath {sbpl_string(prefix_s)})")
    metadata: set[str] = set()
    for p in (connector, run_dir, interpreter, prefix_s, "/opt/homebrew", "/usr/local"):
        if p:
            metadata.update(_ancestors(p))
            metadata.add(p)
    metadata_rules = [f"(literal {sbpl_string(p)})" for p in sorted(metadata)]
    write_rules = [f"(subpath {sbpl_string(run_dir)})"]
    if spec.proxy_port is not None:
        port = int(spec.proxy_port)
        if not 0 < port < 65536:
            raise ValueError("bad proxy port")
        network = f'(allow network-outbound (remote tcp "localhost:{port}"))'
    else:
        network = ";; (no network rule: every connection is denied)"
    template = Template(resources.files(__package__).joinpath(PROFILE_TEMPLATE).read_text("utf-8"))
    indent = "\n  "
    return template.substitute(
        EXEC_RULES=indent.join(exec_rules),
        METADATA_RULES=indent.join(metadata_rules),
        READ_RULES=indent.join(read_rules),
        WRITE_RULES=indent.join(write_rules),
        NETWORK_RULES=network,
    )


class MacSandbox:
    """``sandbox-exec`` with the generated deny-default profile."""

    name = "macos"

    def __init__(self, sandbox_exec: str = SANDBOX_EXEC):
        self.sandbox_exec = sandbox_exec

    def run(self, spec: RunSpec) -> RunOutcome:
        try:
            profile = render_profile(spec)
        except (OSError, ValueError) as e:
            return RunOutcome(error_kind="spawn_failed", message=type(e).__name__, sandbox=self.name)
        argv = [self.sandbox_exec, "-p", profile, *spec.argv]
        result = run_process(
            argv,
            env=spec.env,
            cwd=str(spec.run_dir),
            stdin=spec.stdin,
            timeout_s=spec.timeout_s,
            max_stdout=spec.max_stdout,
        )
        if result.spawn_error:
            return RunOutcome(result, "spawn_failed", result.spawn_error, self.name)
        return RunOutcome(result, sandbox=self.name)


class UnsupportedSandbox:
    """No sandbox on this platform: nothing ever runs."""

    name = "unsupported"

    def run(self, spec: RunSpec) -> RunOutcome:
        return RunOutcome(
            error_kind="sandbox_unavailable", message=SANDBOX_UNAVAILABLE_PL, sandbox=self.name
        )


def default_sandbox() -> ConnectorSandbox:
    if sys.platform == "darwin" and os.path.exists(SANDBOX_EXEC):
        return MacSandbox()
    return UnsupportedSandbox()


__all__ = [
    "ConnectorSandbox",
    "MacSandbox",
    "RunOutcome",
    "RunSpec",
    "UnsupportedSandbox",
    "default_sandbox",
    "render_profile",
    "sbpl_string",
]
