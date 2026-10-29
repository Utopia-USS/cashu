"""The ``ConnectorSandbox`` seam: how one connector process is started.

- :class:`MacSandbox` runs ``/usr/bin/sandbox-exec -p <profile> <argv>`` with a deny-default SBPL profile
  rendered from the package data file ``sandbox.sb`` (read: system, connector dir, interpreter
  installation, run dir; write: run dir; network: none, or only the egress proxy port for fetch runs).
- :class:`DenoSandbox` (docs/agents/connector-runtime.md): a connector whose ``run[0]`` is ``deno`` runs
  under Deno's own permission model (read: connector dir + run dir, write: run dir, network: none, or
  only the manifest hosts on 443 through the egress proxy; no env, sys, run, ffi, remote imports or
  config file), always layered inside a native sandbox (:class:`MacSandbox` on macOS). Deno loads the
  static module graph of the entry script (static imports and literal ``import()``) without a read
  permission check, so before every run the graph is resolved with ``deno info`` and the run is refused
  (``forbidden_import``) when a module lies outside the connector dir or is not a ``file:`` / ``node:``
  module (:func:`module_graph_problem`), or with ``module_parse_error`` when a module of the connector
  does not load or parse (its imports would be invisible).
- :class:`UnsupportedSandbox` (every other platform): nothing runs, every run fails with
  ``sandbox_unavailable``, Deno connectors included: Deno's permissions alone are not enough (raw
  sockets to a manifest host bypass the egress proxy). There is no unsandboxed fallback in production
  code; tests inject their own double (tests/connector_support.py ``NoSandbox``).

Linux hook: :func:`default_sandbox` asks ``sandbox_linux.native_sandbox()`` (a separate module, not
part of this one) for a native sandbox and stays :class:`UnsupportedSandbox` while that module is
missing or returns None.

All go through :func:`process.run_process` (clean env, process group, caps, timeouts).
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from importlib import resources
from pathlib import Path
from string import Template
from typing import Protocol, runtime_checkable
from urllib.parse import unquote, urlsplit

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
# Deno
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
# ``deno info`` resolves the module graph with the same resolution flags as the run (no config file, no
# lockfile, nothing remote, no npm), so it lists exactly what ``deno run`` would load unchecked.
DENO_INFO_FLAGS = ("--json", "--no-config", "--no-lock", "--no-remote", "--no-npm")
GRAPH_TIMEOUT_S = 20.0
MAX_GRAPH_BYTES = 8 * 1024 * 1024
FORBIDDEN_IMPORT = "forbidden_import"
# A module of the connector does not load or parse: its own imports are invisible to the check, so the
# run is refused too, with its own kind (the fix is in the code, not in the imports).
MODULE_PARSE_ERROR = "module_parse_error"
PARSE_SUFFIX = "cannot be loaded or parsed (check it with deno check)"
# ``file:`` modules must be files of the connector. ``node:`` built-ins are allowed: they are code of the
# deno binary itself and every file, network, env or process operation they make passes the same
# permission checks (``node:fs`` or ``createRequire`` reading outside the allow list is ``NotCapable``).
# Every other scheme (``data:``, ``blob:``, ``http(s):``, ``npm:``, ``jsr:``) is refused: a connector
# never needs one, and a ``data:`` module could carry imports of its own.
GRAPH_SCHEMES = ("file", "node")
GRAPH_UNCHECKED = "the module graph could not be checked"


def _deno_path_list(paths: list[str]) -> str:
    """A comma-separated permission list; a comma in a path would split it, so it is refused."""
    for p in paths:
        if "," in p or any(ord(ch) < 32 for ch in p):
            raise ValueError("a comma or control character in a sandbox path")
    return ",".join(paths)


def _deno_script(spec: RunSpec) -> str:
    """The entry script (``spec.argv[1]``) as a real path; it must be a file of the connector: the
    manifest cannot pass Deno flags."""
    if len(spec.argv) < 2:
        raise ValueError("deno needs a script")
    connector = _real(spec.connector_dir)
    script = os.path.realpath(spec.argv[1])
    if not script.startswith(connector + os.sep) or not os.path.isfile(script):
        raise ValueError("the deno script must be a file of the connector")
    return script


def deno_argv(spec: RunSpec) -> list[str]:
    """``deno run <fixed flags> <permissions> <script> <args>`` for ``spec``."""
    script = _deno_script(spec)
    connector = _real(spec.connector_dir)
    run_dir = _real(spec.run_dir)
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


def deno_info_argv(spec: RunSpec) -> list[str]:
    """``deno info --json <resolution flags> <script>``: the module graph of the entry script."""
    return [str(spec.interpreter), "info", *DENO_INFO_FLAGS, _deno_script(spec)]


def _inside(path: str, root: str) -> bool:
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def _graph_urls(info: dict) -> tuple[list[str], list[str]] | str:
    """Every URL of the graph (roots, redirects, modules, resolved code and type dependencies) and the
    modules that failed to load; a problem string when the shape is unexpected or an import does not
    resolve."""
    urls: list[str] = list(info.get("roots") or [])
    redirects = info.get("redirects") or {}
    if not isinstance(redirects, dict):
        return GRAPH_UNCHECKED
    urls += [*redirects.keys(), *redirects.values()]
    broken: list[str] = []
    for module in info["modules"]:
        if not isinstance(module, dict) or not isinstance(module.get("specifier"), str):
            return GRAPH_UNCHECKED
        urls.append(module["specifier"])
        if module.get("error"):
            broken.append(module["specifier"])
        for dep in module.get("dependencies") or []:
            if not isinstance(dep, dict):
                return GRAPH_UNCHECKED
            for key in ("code", "type"):
                target = dep.get(key)
                if target is None:
                    continue
                if not isinstance(target, dict):
                    return GRAPH_UNCHECKED
                if isinstance(target.get("specifier"), str):
                    urls.append(target["specifier"])
                elif target.get("error"):
                    return "an import cannot be resolved (bare names and import maps are not supported)"
    return urls, broken


def module_graph_problem(info: object, connector_dir: str | Path) -> str | None:
    """Why the module graph ``info`` (``deno info --json`` output) breaks the import rule, or None.

    Every module and every resolved dependency (code and types, static and literal dynamic imports)
    must be a ``file:`` URL inside ``connector_dir`` (real paths: a symlink cannot point out) or a
    ``node:`` built-in. No npm package, no import that does not resolve and no module that failed to
    load or parse (its own imports would be invisible). The message is value-free: no path outside
    the connector, no specifier and no source text."""
    root = os.path.realpath(connector_dir)
    if not isinstance(info, dict) or not isinstance(info.get("modules"), list):
        return GRAPH_UNCHECKED
    if info.get("npmPackages"):
        return "npm packages are not allowed"
    collected = _graph_urls(info)
    if isinstance(collected, str):
        return collected
    urls, broken = collected
    for url in urls:
        if not isinstance(url, str):
            return GRAPH_UNCHECKED
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in GRAPH_SCHEMES:
            return (
                "imports must be files of the connector or node: built-ins, not "
                f"{scheme + ':' if scheme else 'bare'} modules"
            )
        if scheme == "file" and (parts.netloc not in ("", "localhost") or not _inside(
            unquote(parts.path), root
        )):
            return "a module outside the connector directory is imported"
    for url in broken:
        parts = urlsplit(url)
        if parts.scheme.lower() == "file":
            rel = os.path.relpath(os.path.realpath(unquote(parts.path)), root)
            return f"{rel} {PARSE_SUFFIX}"
        return f"a module {PARSE_SUFFIX}"
    return None


def module_graph_check(info: object, connector_dir: str | Path) -> tuple[str, str] | None:
    """``(error kind, message)`` for :func:`module_graph_problem`, or None: ``module_parse_error`` for
    a module of the connector that does not load or parse (a syntax error, a missing file), else
    ``forbidden_import``."""
    problem = module_graph_problem(info, connector_dir)
    if problem is None:
        return None
    return (MODULE_PARSE_ERROR if problem.endswith(PARSE_SUFFIX) else FORBIDDEN_IMPORT), problem


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
    """Deno's permission flags inside a native sandbox (``outer``, macOS: MacSandbox), after the
    module-graph check. ``outer=None`` (Deno alone) exists for tests: :func:`sandbox_for` never picks
    it, because Deno alone does not confine raw sockets to the egress proxy."""

    def __init__(self, outer: ConnectorSandbox | None = None):
        self.outer = outer
        self.name = f"deno+{outer.name}" if outer is not None else "deno"

    def _start(self, spec: RunSpec) -> RunOutcome:
        if self.outer is not None:
            return replace(self.outer.run(spec), sandbox=self.name)
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

    def check_graph(self, spec: RunSpec, env: Mapping[str, str]) -> RunOutcome | None:
        """``deno info`` on the entry script, in the same sandbox and without network. None when the
        graph keeps the import rule, else the refusing outcome (``forbidden_import``)."""
        info_spec = replace(
            spec,
            argv=tuple(deno_info_argv(spec)),
            env=env,
            stdin=b"",
            timeout_s=GRAPH_TIMEOUT_S,
            max_stdout=MAX_GRAPH_BYTES,
            proxy_port=None,
            hosts=(),
        )
        outcome = self._start(info_spec)
        if outcome.error_kind:
            return outcome
        p = outcome.process
        if p is None or p.timed_out or p.stdout_overflow or p.exit_code != 0:
            found: tuple[str, str] | None = (FORBIDDEN_IMPORT, GRAPH_UNCHECKED)
        else:
            try:
                info = json.loads(p.stdout.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                info = None
            found = module_graph_check(info, spec.connector_dir)
        if found is None:
            return None
        return RunOutcome(error_kind=found[0], message=found[1], sandbox=self.name)

    def run(self, spec: RunSpec) -> RunOutcome:
        try:
            argv = deno_argv(spec)
        except (OSError, ValueError) as e:
            return RunOutcome(error_kind="spawn_failed", message=str(e), sandbox=self.name)
        env = deno_env(spec)
        refused = self.check_graph(spec, env)
        if refused is not None:
            return refused
        return self._start(replace(spec, argv=tuple(argv), env=env))


class UnsupportedSandbox:
    """No sandbox on this platform: nothing ever runs."""

    name = "unsupported"

    def run(self, spec: RunSpec) -> RunOutcome:
        return RunOutcome(
            error_kind="sandbox_unavailable", message=SANDBOX_UNAVAILABLE_PL, sandbox=self.name
        )


def _linux_sandbox() -> ConnectorSandbox | None:
    """Hook for the Linux native layer: ``sandbox_linux.native_sandbox()`` (a separate module) returns
    a sandbox for this kernel or None. Until that module exists Linux stays unsupported."""
    try:
        from . import sandbox_linux  # type: ignore[attr-defined]
    except ImportError:
        return None
    native = getattr(sandbox_linux, "native_sandbox", None)
    return native() if callable(native) else None


def default_sandbox() -> ConnectorSandbox:
    """The native sandbox of this platform; :class:`UnsupportedSandbox` where there is none."""
    if sys.platform == "darwin" and os.path.exists(SANDBOX_EXEC):
        return MacSandbox()
    if sys.platform.startswith("linux"):
        native = _linux_sandbox()
        if native is not None:
            return native
    return UnsupportedSandbox()


def sandbox_for(run0: str, native: ConnectorSandbox | None = None) -> ConnectorSandbox:
    """The sandbox for a connector whose manifest ``run[0]`` is ``run0``. ``native`` is the platform
    sandbox (default :func:`default_sandbox`). Without a native sandbox nothing runs, Deno connectors
    included; with one, a Deno connector gets :class:`DenoSandbox` layered inside it and every other
    connector ``native`` itself."""
    native = native if native is not None else default_sandbox()
    if isinstance(native, UnsupportedSandbox):
        return native
    if run0 == DENO:
        return DenoSandbox(outer=native)
    return native


__all__ = [
    "FORBIDDEN_IMPORT",
    "MODULE_PARSE_ERROR",
    "ConnectorSandbox",
    "DenoSandbox",
    "MacSandbox",
    "RunOutcome",
    "RunSpec",
    "UnsupportedSandbox",
    "default_sandbox",
    "deno_argv",
    "deno_info_argv",
    "module_graph_check",
    "module_graph_problem",
    "render_profile",
    "sandbox_for",
    "sbpl_string",
]
