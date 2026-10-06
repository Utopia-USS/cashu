"""``finanse connectors test``: the agent developer loop, with a value-free report.

Runs an (also unapproved) connector directory in the same sandbox the app uses: ``detect`` + ``convert``
on a file (file kind) or ``fetch`` offline with a recorded synthetic ``--fixture`` (fetch kind: no
network, no real secrets), then validates the document like the import would. The report has counts per
record kind and type, problem kinds with row numbers and field names, never a value from the file, the
document, a connector message or its stderr.

Budget documents are validated by ``finanse.modules.budget.ingestion.canonical.validate_budget_document``
(``(data: bytes, name: str) -> report`` with ``.ok`` and a value-free ``.summary()``) when that module
provides it; until then only the top-level shape is checked.
"""

from __future__ import annotations

import datetime as dt
import importlib
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import manifest as mf
from . import protocol as proto
from .runner import InputFile, RunResult, RunTarget, execute
from .sandbox import ConnectorSandbox

MAX_FIXTURE_BYTES = 1024 * 1024
FIXTURE_PARAM = "fixture"
PLACEHOLDER_SECRET = "test-not-a-real-secret"
BUDGET_HOOK = "finanse.modules.budget.ingestion.canonical"
BUDGET_FORMAT = "finanse-budget-import"
INVESTMENTS_FORMAT = "finanse-import"
MAX_ROWS_SHOWN = 20


@dataclass
class DevTestReport:
    ok: bool = True
    lines: list[str] = field(default_factory=list)
    runs: list[RunResult] = field(default_factory=list)

    def add(self, line: str) -> None:
        self.lines.append(line)

    def fail(self, line: str) -> None:
        self.ok = False
        self.lines.append(line)

    def text(self) -> str:
        return "\n".join(self.lines)


_CAPITALISED_RUN = re.compile(
    r"\b[A-ZĄĆĘŁŃÓŚŹŻ][\w'-]*(?:[ \t]+[A-ZĄĆĘŁŃÓŚŹŻ][\w'-]*){1,3}\b"
)


def value_free(text: str | None) -> str:
    """A message without the values it may quote: quoted text, IBANs (with a country prefix), long
    numbers and e-mails (the MCP scrubber), runs of 2-4 capitalised words that look like a person's
    name, and numbers other than row / line / column numbers are replaced."""
    from ..mcp.names import looks_like_person
    from ..mcp.redaction import scrub_text

    text = re.sub(r"'[^']*'|\"[^\"]*\"", "'<value>'", text or "")
    text = re.sub(r"\(got [^)]*\)", "(got <value>)", text)
    text = scrub_text(text, strict=False) or ""  # numbers below keep row / line / column
    text = _CAPITALISED_RUN.sub(
        lambda m: "<name>" if looks_like_person(m.group(0)) else m.group(0), text
    )
    return re.sub(r"(?<!row )(?<!line )(?<!column )(?<!rows )\b\d[\d.,]*\b", "#", text)


def _run_line(result: RunResult) -> str:
    if result.ok:
        return f"{result.command}: ok ({result.duration_ms} ms)"
    extra = f", exit code {result.exit_code}" if result.exit_code not in (None, 0, 1) else ""
    message = f": {value_free(result.message)}" if result.message else ""
    return f"{result.command}: {result.outcome} [{result.error_kind}{extra}]{message}"


def run_test(
    source: Path,
    *,
    file: Path | None = None,
    module: str | None = None,
    fixture: Path | None = None,
    check_manifest: bool = False,
    sandbox: ConnectorSandbox | None = None,
) -> DevTestReport:
    report = DevTestReport()
    try:
        loaded = mf.load_dir(source)
    except mf.ManifestError as e:
        report.fail("manifest: INVALID")
        for issue in e.issues:
            report.add(f"  error {issue}")
        return report
    m = loaded.manifest
    report.add(f"manifest: OK ({m.id} {m.version}, module {m.module}, kind {m.kind})")
    report.add(f"  interpreter: {loaded.interpreter}")
    report.add(f"  content sha256: {loaded.content_sha256}")
    if m.kind == "fetch":
        report.add(f"  hosts: {', '.join(m.hosts)}; secrets: {', '.join(m.secret_ids) or '-'}")
    else:
        report.add(f"  extensions: {', '.join(m.extensions)}")
    if module and module != m.module:
        report.fail(f"module: the manifest says {m.module}, not {module}")
        return report
    if check_manifest:
        return report
    target = RunTarget.of(loaded)
    if m.kind == "file":
        if file is None or fixture is not None:
            report.fail("usage: a file connector is tested with --file <export>")
            return report
        document = _test_file(report, target, file, sandbox)
    else:
        if fixture is None or file is not None:
            report.fail(
                "usage: a fetch connector is tested offline with --fixture <recorded synthetic "
                "response>; real secrets are never used here"
            )
            return report
        document = _test_fetch(report, target, fixture, sandbox)
    if document is not None:
        _validate(report, m.module, document)
    return report


def _test_file(
    report: DevTestReport, target: RunTarget, file: Path, sandbox: ConnectorSandbox | None
) -> dict | None:
    if not file.is_file():
        report.fail("file: not found")
        return None
    input_file = InputFile(file, file.name)
    detect = execute(target, "detect", file=input_file, sandbox=sandbox)
    report.runs.append(detect)
    report.add(_run_line(detect))
    if detect.ok:
        r = detect.response
        report.add(f"  match: {'yes' if r.match else 'no'} (confidence {r.confidence:.2f})")
    convert = execute(target, "convert", file=input_file, sandbox=sandbox)
    report.runs.append(convert)
    if not convert.ok:
        report.fail(_run_line(convert))
        return None
    report.add(_run_line(convert))
    return convert.response.document


def _test_fetch(
    report: DevTestReport, target: RunTarget, fixture: Path, sandbox: ConnectorSandbox | None
) -> dict | None:
    try:
        raw = fixture.read_bytes()
    except OSError:
        report.fail("fixture: cannot be read")
        return None
    if len(raw) > MAX_FIXTURE_BYTES:
        report.fail(f"fixture: larger than {MAX_FIXTURE_BYTES // 1024} KiB")
        return None
    try:
        json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report.fail("fixture: not a UTF-8 JSON file")
        return None
    m = target.manifest
    days = m.fetch.history_days if m.fetch else mf.DEFAULT_HISTORY_DAYS
    today = dt.datetime.now(dt.UTC).astimezone().date()  # the local calendar day
    since = (today - dt.timedelta(days=days)).isoformat()
    result = execute(
        target, "fetch", sandbox=sandbox, network=False,
        params={FIXTURE_PARAM: raw.decode("utf-8")},
        secrets={sid: PLACEHOLDER_SECRET for sid in m.secret_ids},
        since=since, cursor=None,
    )
    report.runs.append(result)
    if not result.ok:
        report.fail(_run_line(result))
        return None
    report.add(_run_line(result) + " (offline, fixture)")
    if result.response.cursor is not None:
        report.add(f"  cursor: {len(result.response.cursor)} characters")
    return result.response.document


# --------------------------------------------------------------------------- #
# Document validation
# --------------------------------------------------------------------------- #


def _validate(report: DevTestReport, module: str, document: dict) -> None:
    data = proto.document_bytes(document)
    if module == "investments":
        _validate_investments(report, data)
    else:
        _validate_budget(report, document, data)


def _validate_investments(report: DevTestReport, data: bytes) -> None:
    from finanse.modules.investments.importing import ImportFile, validate_import
    from finanse.modules.investments.importing.canonical import FILE_FIELDS, RECORD_FIELDS

    result = validate_import(ImportFile("document.json", data))
    fields = (*RECORD_FIELDS, *FILE_FIELDS, "format", "records")
    verdict = "OK" if result.ok else "INVALID"
    line = f"document: {verdict} ({INVESTMENTS_FORMAT})"
    (report.add if result.ok else report.fail)(line)
    parsed = result.result
    types = Counter(str(t.type) for t in parsed.txns) if parsed else Counter()
    actions = Counter(type(a).__name__ for a in parsed.corporate_actions) if parsed else Counter()
    report.add(
        f"  transactions: {result.txn_count}"
        + (f" ({', '.join(f'{k} {v}' for k, v in sorted(types.items()))})" if types else "")
    )
    report.add(f"  positions: {result.position_count}")
    report.add(
        f"  corporate actions: {result.corporate_action_count}"
        + (f" ({', '.join(f'{k} {v}' for k, v in sorted(actions.items()))})" if actions else "")
    )
    report.add(f"  errors: {len(result.errors)}, warnings: {len(result.warnings)}")
    for label, issues in (("error", result.errors), ("warning", result.warnings)):
        for line in _by_kind(label, issues, fields):
            report.add(line)


def _by_kind(label: str, issues, fields) -> list[str]:
    grouped: dict[str, list] = defaultdict(list)
    for issue in issues:
        grouped[str(getattr(issue, "kind", "other"))].append(issue)
    lines = []
    for kind, items in sorted(grouped.items()):
        rows = sorted({i.row for i in items if getattr(i, "row", None) is not None})
        named = sorted({
            f for i in items for f in fields if re.search(rf"\b{re.escape(f)}\b", i.message or "")
        })
        shown = ", ".join(str(r) for r in rows[:MAX_ROWS_SHOWN])
        if len(rows) > MAX_ROWS_SHOWN:
            shown += " ..."
        parts = [f"{len(items)}x"]
        if rows:
            parts.append(f"rows {shown}")
        if named:
            parts.append(f"fields {', '.join(named)}")
        lines.append(f"  {label} {kind}: {'; '.join(parts)}")
    return lines


def budget_validator():
    """The budget document validator (BE-C2), or None while the budget module does not provide it."""
    try:
        module = importlib.import_module(BUDGET_HOOK)
    except ImportError:
        return None
    return getattr(module, "validate_budget_document", None)


def _validate_budget(report: DevTestReport, document: dict, data: bytes) -> None:
    validator = budget_validator()
    if validator is not None:
        try:
            result = validator(data, "document.json")
        except Exception as e:  # noqa: BLE001 - a validator bug is reported, never raised
            report.fail(f"document: budget validation failed ({type(e).__name__})")
            return
        ok = bool(getattr(result, "ok", False))
        (report.add if ok else report.fail)(f"document: {'OK' if ok else 'INVALID'} ({BUDGET_FORMAT})")
        summary = getattr(result, "summary", None)
        if callable(summary):
            for line in str(summary()).splitlines():
                report.add(f"  {line}")
        return
    # Shape only until the budget format validator exists.
    problems = []
    if document.get("format") != BUDGET_FORMAT:
        problems.append(f"format must be {BUDGET_FORMAT}")
    if document.get("format_version") != 1:
        problems.append("format_version must be the number 1")
    if not isinstance(document.get("account"), dict):
        problems.append("account must be an object")
    transactions = document.get("transactions")
    if not isinstance(transactions, list):
        problems.append("transactions must be a list")
    balances = document.get("balances", [])
    if not isinstance(balances, list):
        problems.append("balances must be a list")
    if problems:
        report.fail(f"document: INVALID ({BUDGET_FORMAT}, top-level shape)")
        for p in problems:
            report.add(f"  error {p}")
    else:
        report.add(f"document: shape OK ({BUDGET_FORMAT})")
    report.add(
        f"  transactions: {len(transactions) if isinstance(transactions, list) else 0}, "
        f"balances: {len(balances) if isinstance(balances, list) else 0}"
    )
    report.add("  budget validation not available yet (only the top-level shape was checked)")


__all__ = ["DevTestReport", "budget_validator", "run_test", "value_free"]

