"""The ``ConnectorSandbox`` seam: how one connector process is started.

- :class:`MacSandbox` runs ``/usr/bin/sandbox-exec -p <profile> <argv>`` with a deny-default SBPL profile
  rendered from the package data file ``sandbox.sb`` (read: system, connector dir, interpreter
  installation, run dir; write: run dir; network: none, or only the egress proxy port for fetch runs).
- :class:`DenoSandbox` (prototype, docs/agents/connector-runtime.md): a connector whose ``run[0]`` is
  ``deno`` runs under Deno's own permission model (read: connector dir + run dir, write: run dir,
  network: none, or only the manifest hosts on 443 through the egress proxy; no env, sys, run, ffi,
  remote imports or config file). On macOS it is layered inside :class:`MacSandbox`, so the kernel
  profile still applies; elsewhere Deno's permissions are the only confinement.
- :class:`UnsupportedSandbox` (every other platform): nothing runs, every run fails with
  ``sandbox_unavailable``. There is no unsandboxed fallback in production code; tests inject their own
  double (tests/connector_support.py ``NoSandbox``).

All go through :func:`process.run_process` (clean env, process group, caps, timeouts).
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
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
    hosts: tuple[str, ...] = ()  # fetch runs: the manifest hosts (DenoSandbox checks them per request)


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


# --------------------------------------------------------------------------- #
# Deno (cross-OS tier, prototype)
# --------------------------------------------------------------------------- #

DENO = "deno"
# Fixed flags of every Deno run. Anything not granted below is denied (env, sys, run, ffi, net). The
# config file is never read (a deno.json in the connector could turn on unstable APIs or an import
# map), no lockfile is written, nothing remote is resolved or imported (https:, jsr:, npm:), a
# permission is never prompted for and V8's code cache is not written.
DENO_FLAGS = (
    "--no-config",
    "--no-lock",
    "--no-remote",
    "--no-npm",
    "--cached-only",
    "--deny-import",
    "--no-prompt",
    "--no-code-cache",
)
# Variables Deno itself reads at start, all pointing into the run dir or switching chatter off.
DENO_ENV_DIR = ".deno"


def _deno_path_list(paths: list[str]) -> str:
    """A comma-separated permission list; a comma in a path would split it, so it is refused."""
    for p in paths:
        if "," in p or any(ord(ch) < 32 for ch in p):
            raise ValueError("a comma or control character in a sandbox path")
    return ",".join(paths)


def deno_argv(spec: RunSpec) -> list[str]:
    """``deno run <fixed flags> <permissions> <script> <args>`` for ``spec``. The script
    (``spec.argv[1]``) must be a file of the connector: the manifest cannot pass Deno flags."""
    if len(spec.argv) < 2:
        raise ValueError("deno needs a script")
    connector = _real(spec.connector_dir)
    run_dir = _real(spec.run_dir)
    script = os.path.realpath(spec.argv[1])
    if not script.startswith(connector + os.sep) or not os.path.isfile(script):
        raise ValueError("the deno script must be a file of the connector")
    perms = [
        f"--allow-read={_deno_path_list([connector, run_dir])}",
        f"--allow-write={_deno_path_list([run_dir])}",
    ]
    if spec.proxy_port is not None:
        if not spec.hosts:
            raise ValueError("a fetch run without hosts")
        # Deno checks the target host (fetch goes through HTTPS_PROXY, the app's egress proxy).
        perms.append("--allow-net=" + ",".join(f"{h}:443" for h in spec.hosts))
    return [str(spec.interpreter), "run", *DENO_FLAGS, *perms, script, *spec.argv[2:]]


def deno_env(spec: RunSpec) -> dict[str, str]:
    env = dict(spec.env)
    env.update(
        {
            "DENO_DIR": str(Path(_real(spec.run_dir)) / DENO_ENV_DIR),
            "DENO_NO_UPDATE_CHECK": "1",
            "DENO_NO_PROMPT": "1",
            "NO_COLOR": "1",
        }
    )
    return env


class DenoSandbox:
    """Deno's permission flags, optionally inside a native sandbox (``outer``, macOS: MacSandbox)."""

    def __init__(self, outer: ConnectorSandbox | None = None):
        self.outer = outer
        self.name = f"deno+{outer.name}" if outer is not None else "deno"

    def run(self, spec: RunSpec) -> RunOutcome:
        try:
            argv = deno_argv(spec)
        except (OSError, ValueError) as e:
            return RunOutcome(error_kind="spawn_failed", message=str(e), sandbox=self.name)
        inner = replace(spec, argv=tuple(argv), env=deno_env(spec))
        if self.outer is not None:
            return replace(self.outer.run(inner), sandbox=self.name)
        result = run_process(
            inner.argv,
            env=inner.env,
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


def sandbox_for(run0: str, native: ConnectorSandbox | None = None) -> ConnectorSandbox:
    """The sandbox for a connector whose manifest ``run[0]`` is ``run0``. ``native`` is the platform
    sandbox (default :func:`default_sandbox`). Deno connectors get :class:`DenoSandbox`, layered inside
    ``native`` when that is :class:`MacSandbox` and on its own elsewhere; every other one ``native``."""
    native = native if native is not None else default_sandbox()
    if run0 == DENO:
        return DenoSandbox(outer=native if isinstance(native, MacSandbox) else None)
    return native


__all__ = [
    "ConnectorSandbox",
    "DenoSandbox",
    "MacSandbox",
    "RunOutcome",
    "RunSpec",
    "UnsupportedSandbox",
    "default_sandbox",
    "deno_argv",
    "render_profile",
    "sandbox_for",
    "sbpl_string",
]
