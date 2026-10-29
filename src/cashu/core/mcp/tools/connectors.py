"""Connector MCP tools (module-agnostic, F10): ``test_connector``, ``propose_connector`` and
``connectors``.

The rule: the app runs an installed connector on the owner's data only after the owner approves it in
the app (Ustawienia > Konektory), pinned by its content hash, in a sandbox, with a timeout. An MCP call
can never install as approved or approve: ``propose_connector`` installs a copy as ``pending`` (or, for
an installed connector, replaces it so it waits for approval again); validating the manifest resolves
the interpreter path but starts nothing. ``connectors`` lists what is installed with run outcomes and
error kinds only: never a connector's message, its stderr, binding params or secrets (those stay in the
owner's app).

``test_connector`` is the one tool that starts a process: the developer loop of ``cashu connectors
test`` for an agent in a downloaded app (no terminal CLI needed). It runs a connector directory of this
profile's workspace (``connectors/<id>/``, a private copy of it) once, in the same sandbox as approved
runs, on a sample file inside the workspace (file kind) or offline with a recorded fixture inside the
workspace (fetch kind: no network, placeholder secrets). It never installs, approves or records
anything, and returns a value-free report: kinds, counts and messages with values replaced.
"""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

from sqlmodel import col, func, or_, select

from cashu.core import paths

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec

CONNECTORS_FOLDER = "connectors"
RULE = (
    "The app runs an installed connector only after the owner approves it in the app (Ustawienia > "
    "Konektory); MCP calls never install as approved and never approve."
)
TEST_RULE = (
    "test_connector ran a private copy once in the sandbox, offline; nothing was installed, approved "
    "or recorded. Submit it with propose_connector when the report is clean."
)


def _workspace_connectors(slug: str):
    from cashu.core.workspace import service as workspace

    return workspace.workspace_path(slug) / CONNECTORS_FOLDER


def propose_connector(ctx: ToolContext, path: str) -> dict:
    from cashu.core.connectors import manifest as mf
    from cashu.core.connectors import service

    from .exports import checked_local_dir

    folder = checked_local_dir(path, _workspace_connectors(ctx.profile.slug))
    try:
        manifest = mf.load_dir(folder).manifest  # validation only: resolves paths, runs nothing
    except mf.ManifestError as e:
        raise ToolError(_issues("the connector is not valid", e.issues)) from None
    if manifest.id != folder.name:
        raise ToolError(
            f"the directory name must be the connector id: connectors/{manifest.id}/", "invalid"
        )
    try:
        installed = service.install(folder, replace=True, source="mcp")
    except service.ConnectorError as e:
        raise ToolError(_issues(str(e), e.issues)) from None
    row = installed.connector
    m = service.manifest_of(row)
    return {
        "id": L.category(row.id),
        "status": L.category(row.status),
        "replaced": L.flag(installed.replaced),
        "content_sha256": L.text(row.content_sha256[:12]),
        "module": L.category(row.module),
        "kind": L.category(row.kind),
        "hosts": [L.text(h) for h in m.hosts],
        "secret_ids": [L.category(s) for s in m.secret_ids],
        "note": L.text(
            "installed for review; " + RULE + " Tell the owner to review and approve it there."
            + (" For a fetch connector the owner enters the keys in the app." if row.kind == "fetch"
               else "")
        ),
    }


def _workspace_file(raw: str, workspace: Path, what: str) -> Path:
    """A regular file inside this profile's workspace (symlinks resolved), outside hidden folders and
    the cashU data dir."""
    from .exports import inside

    if not raw or "\x00" in raw:
        raise ToolError(f"{what} is required")
    try:
        path = Path(raw).expanduser().resolve(strict=True)
        base = workspace.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ToolError(f"{what}: file not found", "not_found") from None
    if not inside(path, base):
        raise ToolError(
            f"{what} must be a file inside this profile's agent workspace (e.g. connectors/<id>/"
            "fixtures/ or samples/); copy a sample there first"
        )
    if not path.is_file():
        raise ToolError(f"{what}: not a regular file")
    if path.stat().st_nlink > 1:  # another name of a file elsewhere (the data dir, the home)
        raise ToolError(f"{what}: hard-linked files are not read; copy the file into the workspace")
    if any(part.startswith(".") for part in path.relative_to(base).parts):
        raise ToolError(f"{what}: hidden files and files inside hidden folders are not read")
    if inside(path, paths.data_dir().resolve()) or inside(path, paths.LEGACY_DIR.resolve()):
        raise ToolError(f"{what}: files inside the cashU data dir are not read")
    return path


def _interpreter_name(path: str) -> str:
    from cashu.core.connectors import manifest as mf

    name = Path(path).name
    bundled = mf.bundled_interpreter("deno")
    return "deno (bundled with the app)" if bundled is not None and str(bundled) == path else name


# The only text test_connector returns about a run: fixed app-side messages per error kind. Nothing
# the connector wrote (its error message, stderr, stdout) and nothing derived from it (row numbers,
# confidence, durations, exit codes) reaches the agent: unapproved code under test could otherwise
# encode a file it can read in that text (security review F-D1).
KIND_MESSAGES = {
    None: "ok",
    "bad_file": "the connector reported bad_file (its own message is never shown here)",
    "unsupported_version": "the connector reported unsupported_version",
    "auth_failed": "the connector reported auth_failed",
    "rate_limited": "the connector reported rate_limited",
    "network": "the connector reported network (test runs are offline)",
    "upstream": "the connector reported upstream",
    "internal": "the connector failed with internal (an exception or an unknown error kind)",
    "protocol": "the output broke the protocol: one JSON object on stdout, exit code 0 or 1, the "
    "response shape of the command (docs: section 3)",
    "timeout": "no answer within the time limit (detect 10 s, otherwise at most 120 s here)",
    "sandbox_unavailable": "no sandbox on this platform: connectors run only on macOS for now",
    "spawn_failed": "the interpreter could not be started",
    "forbidden_import": "an import breaks the import rule: only files of the connector directory "
    "and node: built-ins (docs: section 4)",
    "module_parse_error": "a module of the connector does not load or parse: run deno check on "
    "its files",
    "bad_request": "the app could not build the request (extension, size or fixture)",
}
OTHER_KIND = "the run failed with this error kind"


def test_connector(ctx: ToolContext, path: str, file: str | None = None,
                   fixture: str | None = None) -> dict:
    from cashu.core.connectors import devtest
    from cashu.core.connectors.runner import MAX_INPUT_BYTES, make_private_run_dir
    from cashu.core.workspace import service as workspace

    from .exports import checked_local_dir

    root = workspace.workspace_path(ctx.profile.slug)
    folder = checked_local_dir(path, root / CONNECTORS_FOLDER)
    if (file is None) == (fixture is None):
        raise ToolError(
            "give exactly one of file (a file connector's sample export) or fixture (a fetch "
            "connector's recorded synthetic API response, used offline)"
        )
    what = "file" if file is not None else "fixture"
    sample = _workspace_file(file or fixture or "", root, what)
    limit = MAX_INPUT_BYTES if file is not None else devtest.MAX_FIXTURE_BYTES
    if sample.stat().st_size > limit:
        raise ToolError(f"the {'file' if file is not None else 'fixture'} is larger than "
                        f"{limit // 1024} KiB")
    base = make_private_run_dir()
    try:
        # A private copy of the sample, checked on the opened file: a hard link made after the
        # path check is refused here, and the run never reads the workspace path again.
        copy = base / sample.name
        try:
            fd = os.open(sample, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            raise ToolError(f"{what}: file not found", "not_found") from None
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                raise ToolError(f"{what}: hard-linked files are not read; copy the file into the "
                                "workspace")
            with open(copy, "xb") as out:
                shutil.copyfileobj(source, out)
        report = devtest.run_test_snapshot(
            folder, file=copy if file is not None else None,
            fixture=copy if fixture is not None else None,
            max_timeout_s=devtest.MCP_MAX_TIMEOUT_S,
            narrow=True,
        )
    finally:
        shutil.rmtree(base, ignore_errors=True)
    m = report.manifest
    out: dict = {
        "ok": L.flag(report.ok),
        "manifest": {
            "valid": L.flag(bool(m)),
            "id": L.category(m.get("id")),
            "version": L.category(m.get("version")),
            "module": L.category(m.get("module")),
            "kind": L.category(m.get("kind")),
            "interpreter": L.category(_interpreter_name(m["interpreter"]) if m else None),
            "issues": [L.text(i) for i in report.manifest_issues[:20]],
        },
        "runs": [
            {
                "command": L.category(r.command),
                "outcome": L.category(r.outcome),
                "error_kind": L.category(r.error_kind),
                "records": L.count(r.records),
                "message": L.text(KIND_MESSAGES.get(r.error_kind, OTHER_KIND)),
            }
            for r in report.runs
        ],
        "detect": None if report.detect is None else {"match": L.flag(report.detect["match"])},
        "document": None if report.document_ok is None else {
            "valid": L.flag(report.document_ok),
            "format": L.category(report.document_format),
            "counts": {k: L.count(v) for k, v in sorted(report.counts.items())},
            "issue_kinds": {k: L.count(v) for k, v in sorted(report.issue_kinds.items())},
        },
        "note": L.text(TEST_RULE),
    }
    if m and m.get("id") != folder.name:
        out["note"] = L.text(TEST_RULE + f" Rename the directory to connectors/{m['id']}/ first.")
    return out


def _issues(message: str, issues) -> str:
    shown = list(issues)[:8]
    more = f" (+{len(issues) - 8} more)" if len(issues) > 8 else ""
    return f"{message}: {'; '.join(shown)}{more}" if shown else message


def connectors(ctx: ToolContext) -> dict:
    from cashu.core.connectors import service
    from cashu.core.connectors.models import Connector, ConnectorBinding, ConnectorRun

    s = ctx.session
    counts = dict(
        s.exec(
            select(ConnectorBinding.connector_id, func.count())
            .where(ConnectorBinding.profile_id == ctx.profile_id)
            .group_by(ConnectorBinding.connector_id)
        ).all()
    )
    items = []
    for row in s.exec(select(Connector).order_by(Connector.id)).all():
        service.refresh(s, row)
        last = s.exec(
            select(ConnectorRun)
            .where(
                ConnectorRun.connector_id == row.id,
                # this profile's runs, or the developer's test runs (no profile); never another's
                or_(ConnectorRun.profile_id == ctx.profile_id, col(ConnectorRun.profile_id).is_(None)),
            )
            .order_by(col(ConnectorRun.id).desc())
            .limit(1)
        ).first()
        items.append(
            {
                "id": L.category(row.id),
                "name": L.text(row.name),
                "module": L.category(row.module),
                "kind": L.category(row.kind),
                "status": L.category(row.status),
                "last_run": None
                if last is None
                else {
                    "command": L.category(last.command),
                    "outcome": L.category(last.outcome),
                    "error_kind": L.category(last.error_kind),
                    "at": L.date(last.started_at),
                    "records": L.count(last.records),
                },
                "bindings": L.count(int(counts.get(row.id, 0))),
            }
        )
    return {"connectors": items, "rule": L.text(RULE)}


TOOLS = (
    ToolSpec(
        "test_connector",
        "core",
        "Test a connector you are writing (a directory connectors/<id>/ in this workspace), before "
        "propose_connector: the app runs a private copy once in the same sandbox as approved runs "
        "(Deno connectors: Deno permissions inside the macOS sandbox, imports only from the "
        "connector's own files and node: built-ins), detect + convert on `file` (a sample export "
        "inside this workspace) for a file connector, or fetch offline with `fixture` (a recorded "
        "synthetic API response inside this workspace, passed as the `fixture` param, placeholder "
        "secrets, no network) for a fetch connector, then validates the document like the import "
        "would. Time limit: detect 10 s, convert / fetch the manifest's timeout_s but at most 120 s "
        "(test with a sample that converts within that). Returns a value-free report: manifest "
        "facts, each run's outcome, error kind, record count and a fixed message for that kind, "
        "the detect match, document validity, counts and issue kinds with their counts. Nothing the "
        "connector writes (its error message, stdout, stderr) is ever returned, so give your "
        "connector precise error kinds and check rows by the issue kinds. Nothing is installed, "
        "approved or recorded.",
        test_connector,
        properties={
            "path": {"type": "string", "maxLength": 1024},
            "file": {"type": "string", "maxLength": 1024},
            "fixture": {"type": "string", "maxLength": 1024},
        },
        required=("path",),
        refused={
            "network": "test_connector never uses the network: test a fetch connector offline with "
            "fixture; real fetches run only after the owner approves the connector in the app",
            "secrets": "test_connector passes placeholder secrets; the owner enters real keys in the "
            "app",
            "approve": "only the owner approves a connector, in the app (Ustawienia > Konektory)",
            "install": "test_connector never installs; submit the connector with propose_connector",
        },
    ),
    ToolSpec(
        "propose_connector",
        "core",
        "Submit a connector you wrote (a directory connectors/<id>/ in this workspace with "
        "connector.yaml and its code; the contract is the import-builder skill's references/connectors.md) for the owner's review. It is "
        "installed as pending (an installed one is replaced and waits for approval again). " + RULE
        + " Returns id, status, hash prefix, module, kind, allowed hosts and secret ids. Test it before "
        "with test_connector. Never ask for API keys: the owner enters them in the app.",
        propose_connector,
        properties={"path": {"type": "string", "maxLength": 1024}},
        required=("path",),
        write=True,
        refused={
            "converter": "propose_connector takes the connector directory only; nothing is run",
            "approve": "only the owner approves a connector, in the app (Ustawienia > Konektory)",
        },
    ),
    ToolSpec(
        "connectors",
        "core",
        "Installed connectors: id, name, module, kind, status (pending / approved / changed / "
        "disabled), the last run's outcome, error kind and time, and how many accounts of this profile "
        "use each. Run messages, logs, parameters and keys stay in the app. " + RULE,
        connectors,
    ),
)
