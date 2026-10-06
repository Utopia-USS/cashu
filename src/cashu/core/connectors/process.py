"""Process control for connector runs: clean environment, own process group, output caps, timeouts.

``run_process`` starts ``argv`` (the sandbox command line) through a tiny ``/bin/sh`` wrapper that sets
RLIMIT_CPU and RLIMIT_FSIZE with ``ulimit`` and then ``exec``s ``/usr/bin/env -i <allowed vars> argv``, so
no ``preexec_fn`` runs in the server process and the child sees only the variables it is given (``sh``
itself would add ``PWD`` / ``SHLVL``). The child gets its own session (``start_new_session``): a timeout or
an output cap kills the whole process group (SIGTERM, 2 s, SIGKILL). stdin is written then closed;
stdout and stderr are read concurrently, stdout capped (the run fails when it is exceeded), stderr kept
as its last 64 KiB. Nothing here raises for a misbehaving child: the outcome says what happened.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

SH = "/bin/sh"
ENV = "/usr/bin/env"
STDERR_KEEP = 64 * 1024
FSIZE_LIMIT = 128 * 1024 * 1024
CPU_GRACE_S = 5
KILL_GRACE_S = 2.0
_CHUNK = 64 * 1024
# $1 = CPU seconds, $2 = file size limit in 1024-byte blocks (macOS /bin/sh), then VAR=value pairs and the
# command for env -i. Nothing is interpolated into the script itself.
_WRAPPER = 'ulimit -t "$1" && ulimit -f "$2" && shift 2 && exec ' + ENV + ' -i "$@"'


@dataclass(frozen=True, slots=True)
class ProcessResult:
    exit_code: int | None
    stdout: bytes
    stderr: bytes
    duration_ms: int
    timed_out: bool = False
    stdout_overflow: bool = False
    spawn_error: str | None = None


def wrapped_argv(
    argv: Sequence[str], env: Mapping[str, str], *, cpu_limit_s: int, fsize_bytes: int = FSIZE_LIMIT
) -> list[str]:
    """The full command line: sh (limits) -> env -i (exactly ``env``) -> ``argv``."""
    if not argv or "=" in argv[0]:
        raise ValueError("argv[0] must be a program path without '='")
    for key in env:
        if not key or "=" in key or not key.replace("_", "").isalnum():
            raise ValueError(f"bad environment variable name {key!r}")
    pairs = [f"{k}={v}" for k, v in env.items()]
    blocks = max(1, fsize_bytes // 1024)
    return [SH, "-c", _WRAPPER, "cashu-connector", str(int(cpu_limit_s)), str(blocks), *pairs, *argv]


def run_process(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    cwd: str,
    stdin: bytes,
    timeout_s: float,
    max_stdout: int,
    stderr_keep: int = STDERR_KEEP,
) -> ProcessResult:
    """Run ``argv`` with exactly ``env`` in ``cwd`` (see the module doc)."""
    cmd = wrapped_argv(argv, env, cpu_limit_s=int(timeout_s) + CPU_GRACE_S)
    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env={},
            start_new_session=True,
            close_fds=True,
        )
    except OSError as e:
        return ProcessResult(None, b"", b"", 0, spawn_error=type(e).__name__)

    out = bytearray()
    err = bytearray()
    overflow = threading.Event()

    def feed() -> None:
        try:
            proc.stdin.write(stdin)
        except (BrokenPipeError, OSError):
            pass  # the child exited or closed stdin early: its exit code / output say why
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    def read_stdout() -> None:
        while chunk := proc.stdout.read1(_CHUNK):
            if len(out) + len(chunk) > max_stdout:
                overflow.set()
                _kill_group(proc, signal.SIGKILL)
                break
            out.extend(chunk)
        _drain(proc.stdout)

    def read_stderr() -> None:
        while chunk := proc.stderr.read1(_CHUNK):
            err.extend(chunk)
            if len(err) > stderr_keep:
                del err[: len(err) - stderr_keep]

    threads = [
        threading.Thread(target=fn, daemon=True, name=f"connector-{fn.__name__}")
        for fn in (feed, read_stdout, read_stderr)
    ]
    for t in threads:
        t.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=KILL_GRACE_S)
        except subprocess.TimeoutExpired:
            _kill_group(proc, signal.SIGKILL)
            proc.wait()
    # Leftover members of the group (a child that forked) never outlive the run.
    _kill_group(proc, signal.SIGKILL)
    for t in threads:
        t.join(timeout=KILL_GRACE_S)
    for stream in (proc.stdout, proc.stderr):
        try:
            stream.close()
        except OSError:
            pass
    duration_ms = int((time.monotonic() - started) * 1000)
    return ProcessResult(
        exit_code=proc.returncode,
        stdout=bytes(out),
        stderr=bytes(err),
        duration_ms=duration_ms,
        timed_out=timed_out,
        stdout_overflow=overflow.is_set(),
    )


def _drain(stream) -> None:
    """Keep reading (and dropping) after an overflow so the child never blocks on a full pipe."""
    try:
        while stream.read1(_CHUNK):
            pass
    except (OSError, ValueError):
        pass


def _kill_group(proc: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


__all__ = ["ProcessResult", "run_process", "wrapped_argv"]
