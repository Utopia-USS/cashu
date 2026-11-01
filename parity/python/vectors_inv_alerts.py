#!/usr/bin/env python3
"""Synthetic alert catalog/validation/evaluation oracles; never opens a dataset."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from alerts_synthetic import evaluations, texts, validations

from cashu.modules.investments.alerts.catalog import catalog_dicts

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "packages/domain/src/investments/alerts/catalogData.ts"
OUT = ROOT / "packages/domain/test/vectors/inv-alerts.json"


def formatted(text: str, path: Path) -> str:
    return subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(path)],
        input=text,
        text=True,
        capture_output=True,
        check=True,
        cwd=ROOT,
    ).stdout


def generate():
    metadata = catalog_dicts()
    source = "// Generated from Python alerts/catalog.py by parity/python/vectors_inv_alerts.py.\n"
    source += (
        "export const CATALOG_DATA = " + json.dumps(metadata, ensure_ascii=False) + " as const;\n"
    )
    text_cases, tags = texts()
    value = {
        "catalog": metadata,
        "validation": validations(),
        "text": text_cases,
        "tag": tags,
        "evaluation": evaluations(),
    }
    return {
        CATALOG: formatted(source, CATALOG),
        OUT: formatted(json.dumps(value, ensure_ascii=False, allow_nan=False), OUT),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    ok = True
    for path, content in generate().items():
        if args.check:
            current = path.exists() and path.read_text() == content
            ok &= current
            print(f"{path.name}: {'pass' if current else 'stale'}")
        else:
            path.write_text(content)
            print(f"{path.name}: generated")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
