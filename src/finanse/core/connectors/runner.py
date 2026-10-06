"""One connector run, without the database: run dir, input copy, request, environment, proxy, sandbox,
response.

``execute`` never raises for a misbehaving connector: every problem becomes a :class:`RunResult` with an
outcome and an error kind. It never touches the database either (the service checks the approval before
and records the run after, each in its own short transaction, so no transaction spans the process).
"""

from __future__ import annotations

import datetime as dt
import os
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import paths
from . import manifest as mf
from . import protocol as proto
from .proxy import EgressProxy
from .sandbox import ConnectorSandbox, RunSpec, default_sandbox

STDERR_STORED = 4 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
FETCH_COMMANDS = proto.FETCH_COMMANDS


@dataclass(frozen=True, slots=True)
class RunTarget:
    """What to run: the connector directory, its manifest and the pinned interpreter."""

    root: Path
    manifest: mf.Manifest
    interpreter: Path

    @classmethod
    def of(cls, loaded: mf.LoadedConnector) -> RunTarget:
        return cls(loaded.root, loaded.manifest, loaded.interpreter)

    def argv(self) -> tuple[str, ...]:
        """The interpreter, then the manifest's arguments; an argument naming a file of the connector
        (``connector.py``) becomes its absolute path, because the process runs in the run dir."""
        root = Path(os.path.realpath(self.root))
        args = []
        for arg in self.manifest.run[1:]:
            candidate = Path(os.path.realpath(root / arg))
            inside = root in candidate.parents
            args.append(str(candidate) if inside and candidate.is_file() else arg)
        return (str(self.interpreter), *args)


@dataclass(frozen=True, slots=True)
class InputFile:
    path: Path
    name: str  # the original file name shown to the connector


@dataclass
class RunResult:
    command: str
    outcome: str  # ok | failed | timeout | refused
    error_kind: str | None = None
    message: str | None = None  # owner-only text (connector message or ours); never sent to MCP
    response: Any = None  # the parsed response model when ok
    exit_code: int | None = None
    duration_ms: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    denied_hosts: list[str] = field(default_factory=list)
    stderr_tail: str | None = None
    records: int = 0
    started_at: dt.datetime = field(default_factory=lambda: dt.datetime.now(dt.UTC))
    run_id: int | None = None

    @property
    def ok(self) -> bool:
        return self.outcome == "ok"


def runs_dir() -> Path:
    return paths.data_dir() / "tmp" / "connectors"


def make_private_run_dir() -> Path:
    """A fresh owner-only dir under :func:`runs_dir` (a run dir, or a run's code snapshot)."""
    return _make_run_dir()


def _make_run_dir() -> Path:
    base = runs_dir()
    current = paths.ensure_private_dir(paths.data_dir())
    for part in ("tmp", "connectors"):
        current = paths.ensure_private_dir(current / part)
    run_dir = base / uuid.uuid4().hex
    run_dir.mkdir(mode=0o700)
    os.chmod(run_dir, 0o700)
    return Path(os.path.realpath(run_dir))


def base_env(run_dir: Path, interpreter: Path, proxy_port: int | None) -> dict[str, str]:
    """The child's whole environment (nothing is inherited)."""
    env = {
        "PATH": f"/usr/bin:/bin:{interpreter.parent}",
        "HOME": str(run_dir),
        "TMPDIR": str(run_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "FINANSE_CONNECTOR_API": str(proto.API_VERSION),
    }
    if proxy_port is not None:
        proxy = f"http://127.0.0.1:{proxy_port}"
        env.update({"HTTPS_PROXY": proxy, "HTTP_PROXY": proxy, "NO_PROXY": ""})
    return env


def without_secrets(text: str, secrets: dict[str, str] | None) -> str:
    """``text`` with every secret value of the run replaced (a connector may echo its key)."""
    for value in sorted((v for v in (secrets or {}).values() if v), key=len, reverse=True):
        text = text.replace(value, "[secret]")
    return text


def redact(text: str, secrets: dict[str, str] | None) -> str:
    """Stored text: secrets replaced, then the MCP scrubber (IBANs, long numbers, amounts, e-mails)."""
    from ..mcp.redaction import scrub_text

    return scrub_text(without_secrets(text, secrets), strict=True) or ""


def _tail(raw: bytes, secrets: dict[str, str] | None) -> str | None:
    if not raw:
        return None
    # A margin before scrubbing, so a secret or number cut at the edge is still caught.
    text = raw[-4 * STDERR_STORED :].decode("utf-8", errors="replace")
    text = redact(text, secrets)
    encoded = text.encode("utf-8")
    if len(encoded) > STDERR_STORED:
        text = encoded[-STDERR_STORED:].decode("utf-8", errors="ignore")
    return text


def execute(
    target: RunTarget,
    command: str,
    *,
    file: InputFile | None = None,
    account: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    secrets: dict[str, str] | None = None,
    since: str | None = None,
    cursor: str | None = None,
    sandbox: ConnectorSandbox | None = None,
    network: bool = True,
) -> RunResult:
    """Run ``command`` once (see the module doc). ``network=False`` keeps a fetch run offline (tests
    with a fixture)."""
    m = target.manifest
    started = dt.datetime.now(dt.UTC)
    if command not in proto.COMMANDS:
        return RunResult(command, "refused", "bad_request", f"unknown command {command!r}")
    needs_file = command in proto.FILE_COMMANDS
    if needs_file != (m.kind == "file"):
        return RunResult(command, "refused", "bad_request", f"{command} is not a {m.kind} command")
    if needs_file:
        if file is None:
            return RunResult(command, "refused", "bad_request", "no input file")
        ext = Path(file.name).suffix.lower().lstrip(".")
        if ext not in m.extensions:
            return RunResult(
                command, "refused", "bad_request",
                f"the connector reads {', '.join(m.extensions)}, not {ext or 'files without extension'}",
            )
        try:
            if file.path.stat().st_size > MAX_INPUT_BYTES:
                return RunResult(command, "refused", "bad_request", "the file is too large")
        except OSError:
            return RunResult(command, "refused", "bad_request", "the file cannot be read")
    timeout = mf.DETECT_TIMEOUT_S if command == "detect" else m.timeout_s
    sandbox = sandbox or default_sandbox()

    run_dir = _make_run_dir()
    proxy: EgressProxy | None = None
    try:
        request = proto.Request(
            command=command,
            module=m.module,
            account=proto.RequestAccount(**account) if account else None,
            params=params or {},
            secrets=(secrets or {}) if command in FETCH_COMMANDS else None,
            since=since if command == "fetch" else None,
            cursor=cursor if command == "fetch" else None,
        )
        if needs_file:
            ext = Path(file.name).suffix.lower().lstrip(".")
            copy = run_dir / f"input.{ext}"
            shutil.copyfile(file.path, copy)  # a copy: the original location is never exposed
            os.chmod(copy, 0o600)
            request.file = proto.RequestFile(path=str(copy), name=Path(file.name).name)
        port = None
        if command in FETCH_COMMANDS and network:
            proxy = EgressProxy(m.hosts)
            port = proxy.start()
        spec = RunSpec(
            argv=target.argv(),
            connector_dir=target.root,
            interpreter=target.interpreter,
            run_dir=run_dir,
            env=base_env(run_dir, target.interpreter, port),
            stdin=request.to_bytes(),
            timeout_s=float(timeout),
            max_stdout=proto.MAX_STDOUT_BYTES,
            proxy_port=port,
        )
        outcome = sandbox.run(spec)
    except Exception as e:  # noqa: BLE001 - a run never raises through (recorded instead)
        return RunResult(command, "failed", "spawn_failed", type(e).__name__, started_at=started)
    finally:
        if proxy is not None:
            proxy.stop()
        shutil.rmtree(run_dir, ignore_errors=True)

    result = RunResult(command, "failed", started_at=started)
    if proxy is not None:
        result.bytes_in, result.bytes_out = proxy.bytes_down, proxy.bytes_up
        result.denied_hosts = list(proxy.denied_hosts)
    if outcome.error_kind:
        result.outcome = "refused" if outcome.error_kind == "sandbox_unavailable" else "failed"
        result.error_kind, result.message = outcome.error_kind, outcome.message
        return result
    p = outcome.process
    result.exit_code = p.exit_code
    result.duration_ms = p.duration_ms
    result.stderr_tail = _tail(p.stderr, secrets)
    if p.timed_out:
        result.outcome, result.error_kind = "timeout", "timeout"
        result.message = f"no answer within {timeout} s"
        return result
    if p.stdout_overflow:
        result.error_kind = "protocol"
        result.message = f"stdout larger than {proto.MAX_STDOUT_BYTES // (1024 * 1024)} MiB"
        return result
    parsed = proto.parse_response(command, p.exit_code, p.stdout)
    if parsed.error_kind:
        result.error_kind = parsed.error_kind
        result.message = without_secrets(parsed.message, secrets) if parsed.message else None
        return result
    result.outcome = "ok"
    result.response = parsed.response
    if isinstance(parsed.response, proto.DocumentResponse):
        result.records = proto.document_records(m.module, parsed.response.document)
    return result


__all__ = [
    "InputFile",
    "RunResult",
    "RunTarget",
    "base_env",
    "execute",
    "make_private_run_dir",
    "redact",
    "runs_dir",
    "without_secrets",
]
