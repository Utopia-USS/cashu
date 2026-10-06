#!/usr/bin/env python3
"""Refresh the reference copies inside the Claude Code skills (``.claude/skills/<skill>/references/``).

Skills leave the repository (``finanse skills install``, the per-profile agent workspaces, the
packaged app), so a skill never points at repository files: the docs it needs are copied into its
own ``references/`` folder, with repository paths rewritten to the copies' names. Run after editing
one of the sources:

    python scripts/sync_skill_references.py          # write the copies
    python scripts/sync_skill_references.py --check  # exit 1 when a copy is stale (the tests run it)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".claude" / "skills"
STRATEGY = "src/finanse/modules/investments/templates/strategy"
EXPRESSIONS = "src/finanse/modules/investments/rules/expr/EXPRESSIONS.md"
GENERIC_CSV = "src/finanse/modules/investments/importing/generic_csv_example.yaml"
EXAMPLES = "examples/connectors"
CONNECTOR_EXAMPLES = ("budget-csv-example", "investments-json-example", "fetch-example")
SCHEMAS = (
    "connector-manifest.v1.json",
    "connector-protocol.v1.json",
    "finanse-budget-import.v1.json",
    "finanse-import.v1.json",
)

# (skill, file inside the skill, source in the repository)
COPIES: list[tuple[str, str, str]] = [
    ("investments-setup", "references/strategy-schema.md", f"{STRATEGY}/README.md"),
    ("investments-setup", "references/expressions.md", EXPRESSIONS),
    ("investments-setup", "references/templates/passive_etf.yaml", f"{STRATEGY}/passive_etf.yaml"),
    ("investments-setup", "references/templates/blank.yaml", f"{STRATEGY}/blank.yaml"),
    ("extension-builder", "references/strategy-schema.md", f"{STRATEGY}/README.md"),
    ("extension-builder", "references/expressions.md", EXPRESSIONS),
    ("import-builder", "references/import-format.md", "docs/import-format.md"),
    ("import-builder", "references/generic_csv_example.yaml", GENERIC_CSV),
    ("import-builder", "references/connectors.md", "docs/connectors.md"),
    ("import-builder", "references/budget-import-format.md", "docs/budget-import-format.md"),
    *[("import-builder", f"references/schemas/{name}", f"docs/schemas/{name}") for name in SCHEMAS],
    *[
        ("import-builder", f"references/connector-examples/{example}/{name}", f"{EXAMPLES}/{example}/{name}")
        for example in CONNECTOR_EXAMPLES
        for name in ("connector.yaml", "connector.py")
    ],
]

# Repository paths inside the sources -> what the copy calls them (copies sit side by side).
REWRITES: list[tuple[str, str]] = [
    (f"`{EXPRESSIONS}`", "`expressions.md`"),
    (EXPRESSIONS, "expressions.md"),
    (f"`{GENERIC_CSV}`", "`generic_csv_example.yaml`"),
    (GENERIC_CSV, "generic_csv_example.yaml"),
    ("`tests/investments/strategy/test_strategy_templates.py`", "the finanse test suite"),
    (f"../{EXAMPLES}/", "connector-examples/"),
    (f"{EXAMPLES}/", "connector-examples/"),
    ("docs/import-format.md", "import-format.md"),
    ("docs/budget-import-format.md", "budget-import-format.md"),
    ("docs/connectors.md", "connectors.md"),
]

NOTE = "Copy shipped with this skill, generated from the finanse sources; do not edit it here."


def render(source: Path, dest: str) -> str:
    text = source.read_text(encoding="utf-8")
    for old, new in REWRITES:
        text = text.replace(old, new)
    if dest.endswith(".json"):
        return text  # JSON has no comments: copied verbatim (its $id / description name the source)
    if dest.endswith(".md"):
        return f"<!-- {NOTE} -->\n\n{text}"
    return f"# {NOTE}\n{text}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only report stale copies")
    args = parser.parse_args(argv)
    stale = []
    for skill, dest, source in COPIES:
        target = SKILLS / skill / dest
        wanted = render(ROOT / source, dest)
        current = target.read_text(encoding="utf-8") if target.is_file() else None
        if current == wanted:
            continue
        stale.append(f"{skill}/{dest}")
        if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(wanted, encoding="utf-8")
    if args.check and stale:
        print(
            "Stale skill reference copies (run `python scripts/sync_skill_references.py`): "
            + ", ".join(stale),
            file=sys.stderr,
        )
        return 1
    for name in stale:
        print(f"updated {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
