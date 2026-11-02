"""Actual Python MCP wire oracles over invented exports and the existing synthetic view fixture."""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import io
import json
import os
import sqlite3
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "packages/parity/src/producers/mcp/fixtures/investments-read.json"
INSPECT_TARGET = ROOT / "packages/mcp/src/tools/fixtures/exports.json"
IMPORT_TARGET = ROOT / "packages/mcp/src/tools/fixtures/imports.json"


def generate(root: Path):
    os.environ.update(
        CASHU_DATA_DIR=str(root / "data"),
        HOME=str(root),
        CASHU_TESTING="1",
        CASHU_AUTO_DAILY="0",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        TZ="Europe/Warsaw",
    )
    import canon
    import frozen
    import golden

    golden.import_all()
    frozen.install("2026-10-01T12:00:00")
    from sqlmodel import Session, create_engine, select

    from cashu.core.i18n import use_language
    from cashu.core.mcp.redaction import LeakDetected, Redactor, UnlabelledValue, leak_check
    from cashu.core.mcp.registry import ToolContext, all_tools, validate_arguments
    from cashu.core.mcp.tools.exports import inspect_file
    from cashu.core.models import Profile

    fixture = json.loads(
        (ROOT / "packages/parity/src/producers/investments/fixtures/review-views.json").read_text()
    )
    data = root / "data"
    data.mkdir(parents=True)
    dbpath = data / "cashu.db"
    with sqlite3.connect(dbpath) as connection:
        connection.executescript(fixture["sql"])
    for name, value in fixture["files"].items():
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    extra_files = {
        "market/calendar.json": json.dumps({
            "fetched_at": "2026-10-01T12:00:00+00:00", "from": "2026-10-01", "to": "2026-10-15",
            "macro": [{"date": "2026-10-02", "time": "12:30", "country": "US", "title": "Public GDP announcement"}],
            "earnings": [], "errors": [],
        })
    }
    for name, value in extra_files.items():
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    engine = create_engine(f"sqlite:///{dbpath}")
    names = [
        "portfolio_overview",
        "positions",
        "signals",
        "review_context",
        "strategy_status",
        "history_metrics",
        "theses",
    ]

    def capture(session):
        results = {}
        ids = canon.IdMap(session)
        mapper = canon.Canon(ids)
        profiles = list(session.exec(select(Profile).order_by(Profile.slug)).all())
        for mode in ("strict", "amounts"):
            per_mode = {}
            for profile in profiles:
                per = {}
                for name in names:
                    variants = (
                        [{"status": s} for s in ("open", "history", "all")]
                        if name == "signals"
                        else [{}]
                    )
                    for arguments in variants:
                        spec = all_tools()[name]
                        from cashu.core import profiles as profiles_core

                        key = name + "(" + ",".join(f"{k}={v}" for k, v in arguments.items()) + ")"
                        if not spec.enabled_in(
                            set(profiles_core.enabled_modules(session, profile.id))
                        ):
                            per[key] = {"error_kind": "module_disabled"}
                            continue
                        ctx = ToolContext(session, profile, mode, dt.date(2026, 10, 1))
                        with use_language("pl"):
                            tree = spec.handler(ctx, **validate_arguments(spec, arguments))
                            redactor = Redactor(mode, ctx.guard)
                            try:
                                value = redactor.apply(tree)
                                leak_check(
                                    value,
                                    strict=redactor.strict,
                                    isins=redactor.isins,
                                    non_money=redactor.non_money,
                                )
                                per[key] = mapper.value(value, f"$.{name}")
                            except LeakDetected:
                                per[key] = {"error_kind": "privacy_check"}
                            except UnlabelledValue:
                                per[key] = {"error_kind": "unlabelled"}
                per_mode[ids.key("profiles", profile.id)] = per
            results[mode] = per_mode
        return results

    with Session(engine) as session:
        baseline = capture(session)
    delta = """
UPDATE inv_transactions SET trade_date='2026-09-30', quantity='0.1' WHERE id=2;
UPDATE inv_transactions SET instrument_id=1, trade_date='2026-09-26', quantity='0.7' WHERE id=6;
UPDATE alerts SET id=123456, deleted_at='2026-09-30 10:00:00.000000' WHERE id=1;
UPDATE inv_signals SET rule_id='alert:123456', dedup_key='alert:123456' WHERE id=2;
UPDATE inv_signals SET kind='custom',payload='{"values":{"weight":true},"when":"weight > 0.5"}' WHERE id=1;
UPDATE inv_signals SET rule_id='alert:lookalike',payload='{"values":{"weight":true,"days_since_last_deposit":false},"when":"weight > 0.5"}' WHERE id=4;
"""
    with sqlite3.connect(dbpath) as connection:
        connection.executescript(delta)
    # Direct synthetic SQL bypasses the normal import invalidation; each oracle scenario is fresh.
    from cashu.modules.investments.performance import service as performance

    performance.clear_cache()
    with Session(engine) as session:
        edge = capture(session)
    results = {"base": baseline, "edge": {"sql_delta": delta, "expected": edge}, "extra_files": extra_files}
    samples = {
        "operations.csv": "Preamble;private owner\nDate;Type;Symbol;Name;Amount\n2026-01-02;BUY;ZXQ;Anna2000;-1 234,50\n2026-01-03;SELL;ZXQ;Łódź99;12,00\n",
        "no-header.tsv": "2026-01-02\t12345678901\tJan Kowalski\n2026-01-03\t98765432109\tanna@example.invalid\n",
        "unicode.txt": "kind|description|amount\nBUY|PRZELEWSKI ŁÓDŹ9999|1.00\nSELL|OPEN BUY Anna2000 1 @ 12.30|2.50\n",
        "preamble.csv": "Name;Account;Currency;Balance\nAnna Nowak;12345678901;PLN;200\n\nDate;Type;Value\n2026-01-02;BUY;1.00\n2026-01-03;SELL;2.00\n2026-01-04;BUY;3.00\n",
        "empty.csv": "",
        "malformed.csv": "header\nfoo\rbar",
        "records.json": '[{"2":1,"1":1.0,"2":2,"__proto__":"Anna2000","kind":"BUY"},{"2":3,"1":2e2,"kind":"SELL"}]',
        "structure.json": '{"Jan Kowalski":1.0,"123456":null,"foo":[1,2],"bar":{},"nan":NaN}',
        "names.csv": "TYPE;Name;ISIN;Ticker;Currency\nBUY;JAN KOWALSKI;US0378331005;ZXQ;PLN\nBUY;ANNA NOWAK;US0378331005;ZXQ;PLN\n",
    }
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    samples["wide.csv"] = ((";".join(["x"] * 201) + "," + ",".join(["x"] * 300)) + "\n") * 3
    xlsx = io.BytesIO()

    def write(z, name, value):
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, value)

    with zipfile.ZipFile(xlsx, "w", zipfile.ZIP_DEFLATED) as z:
        write(
            z,
            "xl/workbook.xml",
            f'<workbook {ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Operations" sheetId="1" r:id="r1"/></sheets></workbook>',
        )
        write(
            z,
            "xl/_rels/workbook.xml.rels",
            '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        write(
            z,
            "xl/styles.xml",
            f'<styleSheet {ns}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        )
        write(
            z,
            "xl/sharedStrings.xml",
            f"<sst {ns}><si><t>Date</t></si><si><t>Amount</t></si><si><r><t>Anna</t></r><r><t>2000</t></r></si></sst>",
        )
        write(
            z,
            "xl/worksheets/sheet1.xml",
            f'<worksheet {ns}><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Person</t></is></c></row><row r="1048576"><c r="A1048576" s="1"><v>46000.9</v></c><c r="B2"><f>1+1</f><v>2</v></c><c r="C2" t="s"><v>2</v></c><c r="XFD2"><v>999</v></c></row></sheetData></worksheet>',
        )
    byte_samples = {name: value.encode() for name, value in samples.items()}
    byte_samples["operations.xlsx"] = xlsx.getvalue()
    utf16 = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(xlsx.getvalue())) as original, zipfile.ZipFile(utf16, "w") as z:
        for name in original.namelist():
            content = original.read(name)
            if name.endswith("sheet1.xml"):
                content = ('<?xml version="1.0" encoding="UTF-16"?>' + content.decode()).encode(
                    "utf-16"
                )
            write(z, name, content)
    byte_samples["operations-utf16.xlsx"] = utf16.getvalue()
    vectors = []
    for name, content in byte_samples.items():
        path = root / name
        path.write_bytes(content)
        for max_samples in (0, 5):
            expected = {}
            for mode in ("strict", "amounts"):
                redactor = Redactor(mode)
                try:
                    value = redactor.apply(inspect_file(path, max_samples=max_samples))
                except csv.Error:
                    # The Python server's generic exception boundary reports this as internal.
                    expected[mode] = json.dumps({"error_kind": "internal"})
                    continue
                leak_check(
                    value,
                    strict=redactor.strict,
                    isins=redactor.isins,
                    non_money=redactor.non_money,
                )
                expected[mode] = json.dumps(value, ensure_ascii=False, sort_keys=True)
            vectors.append(
                {
                    "name": name,
                    "content": base64.b64encode(content).decode(),
                    "max_samples": max_samples,
                    "expected": expected,
                }
            )
    from cashu.core.mcp.tools.investments_proposals import validate_file

    import_vectors = []
    with Session(engine) as session:
        profile = session.exec(select(Profile).order_by(Profile.id)).first()
        for mapping in (None, "version: ١٢٣\n", "version: 1\ncolumns: {type: ١٢٣}\n"):
            path = root / "invalid.csv"
            path.write_text("invalid\n")
            expected = {}
            for mode in ("strict", "amounts"):
                ctx = ToolContext(session, profile, mode, dt.date(2026, 10, 1))
                redactor = Redactor(mode, ctx.guard)
                value = redactor.apply(validate_file(ctx, str(path), mapping=mapping))
                leak_check(
                    value,
                    strict=redactor.strict,
                    isins=redactor.isins,
                    non_money=redactor.non_money,
                )
                expected[mode] = json.dumps(value, ensure_ascii=False, sort_keys=True)
            import_vectors.append(
                {
                    "name": "invalid.csv",
                    "text": "invalid\n",
                    "mapping": mapping,
                    "expected": expected,
                }
            )
    return results, vectors, import_vectors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-mcp-investment-vectors-") as directory:
        results, vectors, import_vectors = generate(Path(directory))
    for target, value in (
        (TARGET, results),
        (INSPECT_TARGET, vectors),
        (IMPORT_TARGET, import_vectors),
    ):
        output = subprocess.run(
            ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(target)],
            input=json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            text=True,
            capture_output=True,
            check=True,
            cwd=ROOT,
        ).stdout
        if args.check:
            if not target.exists() or target.read_text() != output:
                raise SystemExit("MCP synthetic vectors are stale")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(output)
    print(
        "MCP investment synthetic vectors: current"
        if args.check
        else "MCP investment synthetic vectors: generated"
    )


if __name__ == "__main__":
    main()
