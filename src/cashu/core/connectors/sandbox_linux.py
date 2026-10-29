"""Linux connector sandbox: Landlock, applied by a launcher in the child just before ``exec``.

The command line is ``<launcher> <policy json> -- <argv>``, run through :func:`process.run_process` like
every sandbox (clean env, own process group, caps, timeouts). The launcher is this app's own Python
running ``cashu.core.connectors.landlock_exec`` (from source) or the packaged binary in its
``--landlock-exec`` mode (``desktop/entry.py``).

What a connector may touch (deny everything else; the kernel enforces it for the connector and all its
children):

- read: ``/usr``, ``/lib*``, ``/etc/ld.so.cache``, the TLS trust store under ``/etc``, ``/dev/urandom``,
  the connector directory, the run directory, the interpreter's installation when it is not under
  ``/usr`` (pyenv, a custom prefix);
- execute: the interpreter, its ELF loader, files of the connector directory (and the interpreter's own
  installation when it is outside the system dirs); never ``/bin/sh`` or anything in the run dir;
- write: the run directory and ``/dev/null``;
- network: none. Landlock ABI >= 4 (Linux 6.7+) denies TCP bind and connect; a private network
  namespace is added when the kernel allows unprivileged user namespaces (required with ABI < 4).
  Fetch runs are refused for now (see :class:`LinuxSandbox`).
- ABI >= 6 (Linux 6.12+): abstract Unix sockets and signals are scoped to the sandbox.
- seccomp: only TCP sockets, no Unix sockets / UDP / netlink, no io_uring, ptrace, process_vm_*, bpf,
  perf_event_open, keyrings, mounts, namespaces or personality (EPERM).

The sandbox is offered only when :func:`available` (Landlock present and the seccomp filter installs).
Residual risks are listed in ``docs/agents/connector-sandbox-platforms.md``.
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
from pathlib import Path

from . import landlock_exec as ll
from . import manifest as mf
from .process import run_process
from .sandbox import RunOutcome, RunSpec

LAUNCHER_MODULE = "cashu.core.connectors.landlock_exec"
LAUNCHER_ARG = "--landlock-exec"  # = desktop.entry.LANDLOCK_EXEC

SYSTEM_READ = (
    "/usr",
    "/lib",
    "/lib64",
    "/lib32",
    "/libx32",
    "/etc/ld.so.cache",
    "/etc/ssl",  # Debian / Ubuntu CA bundle and openssl.cnf
    "/etc/pki",  # Fedora / RHEL CA bundle
    "/etc/ca-certificates",
    "/etc/crypto-policies",  # Fedora openssl config includes
    "/etc/localtime",
    "/dev/urandom",
    "/dev/random",
    "/dev/zero",
)
DEVICES_RW = ("/dev/null",)

UNAVAILABLE_PL = "Konektory na Linuksie wymagają jądra z Landlock (Linux 5.13 lub nowszy, włączony LSM)."
FETCH_UNAVAILABLE_PL = (
    "Konektory pobierające dane (fetch) nie działają jeszcze na Linuksie; konektory plikowe tak."
)
REFUSED_PL = "Piaskownica Landlock nie mogła zostać założona: konektor nie został uruchomiony."


def _real(path: Path | str) -> str:
    return os.path.realpath(path)


def launcher_argv() -> list[str]:
    """How to start the launcher: the packaged binary's mode, or this Python with the module."""
    if getattr(sys, "frozen", False):
        return [sys.executable, LAUNCHER_ARG]
    return [sys.executable, "-I", "-m", LAUNCHER_MODULE]


def build_policy(spec: RunSpec, *, report: bool = False) -> dict:
    """The launcher policy for ``spec`` (real paths; the kernel checks inodes)."""
    connector = _real(spec.connector_dir)
    run_dir = _real(spec.run_dir)
    interpreter = _real(spec.interpreter)
    paths: list[list[str]] = [[p, "r"] for p in SYSTEM_READ if os.path.exists(p)]
    paths += [[p, "dev"] for p in DEVICES_RW if os.path.exists(p)]
    prefix = mf.interpreter_prefix(Path(interpreter))
    if prefix is not None and not _real(prefix).startswith("/usr/"):
        paths.append([_real(prefix), "rx"])
    paths.append([interpreter, "rx"])
    loader = ll.elf_interpreter(interpreter)
    if loader:
        paths.append([_real(loader), "rx"])
    paths.append([connector, "rx"])
    paths.append([run_dir, "rw"])
    policy: dict = {"paths": paths, "net": "none", "min_abi": 1}
    if spec.proxy_port is not None:
        port = int(spec.proxy_port)
        if not 0 < port < 65536:
            raise ValueError("bad proxy port")
        policy.update(net="proxy", port=port, min_abi=ll.NET_ABI)
    if report:
        policy["report"] = True
    return policy


PROBE_TIMEOUT_S = 15.0


@functools.cache
def available() -> bool:
    """Landlock is there and the launcher could install the seccomp filter (checked once per process
    by ``<launcher> --probe`` in a child; the app itself is never restricted)."""
    if not sys.platform.startswith("linux") or ll.machine() not in ll.SYSCALLS or ll.abi_version() < 1:
        return False
    try:
        probe = subprocess.run(
            [*launcher_argv(), "--probe"], env={}, stdin=subprocess.DEVNULL, capture_output=True,
            timeout=PROBE_TIMEOUT_S, cwd="/", check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return probe.returncode == 0


def native_sandbox() -> LinuxSandbox | None:
    """The hook :func:`sandbox.default_sandbox` calls on Linux: a sandbox when this kernel has one."""
    return LinuxSandbox() if available() else None


class LinuxSandbox:
    """Landlock + seccomp (plus a private network namespace for file runs when allowed). File
    connectors only: a fetch run is refused until a namespace relay forces its traffic through the proxy
    (Landlock's TCP rule is port-only; docs/agents/connector-sandbox-platforms.md)."""

    name = "linux"

    def __init__(self, *, report: bool = False):
        self.report = report

    def run(self, spec: RunSpec) -> RunOutcome:
        if spec.proxy_port is not None:
            return RunOutcome(error_kind="sandbox_unavailable", message=FETCH_UNAVAILABLE_PL, sandbox=self.name)
        return self.launch(spec)

    def launch(self, spec: RunSpec) -> RunOutcome:
        """Start ``spec`` in the sandbox, fetch runs included (the launcher layer, for tests and the
        future relay; production goes through :meth:`run`)."""
        abi = ll.abi_version()
        if abi < 1:
            return RunOutcome(error_kind="sandbox_unavailable", message=UNAVAILABLE_PL, sandbox=self.name)
        if spec.proxy_port is not None and abi < ll.NET_ABI:
            return RunOutcome(
                error_kind="sandbox_unavailable", message=FETCH_UNAVAILABLE_PL, sandbox=self.name,
                extra={"abi": abi},
            )
        try:
            policy = build_policy(spec, report=self.report)
        except (OSError, ValueError) as e:
            return RunOutcome(error_kind="spawn_failed", message=type(e).__name__, sandbox=self.name)
        argv = [*launcher_argv(), json.dumps(policy, separators=(",", ":")), "--", *spec.argv]
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
        if result.exit_code == ll.REFUSED_EXIT and ll.MARKER.encode() in result.stderr:
            return RunOutcome(result, "sandbox_unavailable", REFUSED_PL, self.name, {"abi": abi})
        return RunOutcome(result, sandbox=self.name, extra={"abi": abi})


__all__ = ["LinuxSandbox", "available", "build_policy", "launcher_argv"]
