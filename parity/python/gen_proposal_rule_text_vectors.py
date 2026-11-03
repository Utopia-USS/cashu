"""Actual pure Python proposal helpers, imported only after complete synthetic isolation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/store/src/investments/services/fixtures/proposalRuleText.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-s60-rule-text-") as temporary:
        root = Path(temporary).resolve()
        os.environ.update(
            CASHU_TESTING="1",
            HOME=str(root / "home"),
            CASHU_DATA_DIR=str(root / "data"),
            CASHU_LEGACY_DATA_DIR=str(root / "legacy"),
            CASHU_WORKSPACES_DIR=str(root / "workspaces"),
            CASHU_LAUNCH_AGENTS_DIR=str(root / "agents"),
            CASHU_AUTO_DAILY="0",
            CASHU_LANG="en",
        )
        os.environ["CASHU_DATABASE_URL"] = f"sqlite:///{root / 'data' / 'cashu.db'}"
        for folder in [root / "home", root / "data"]:
            folder.mkdir()
        from cashu.core import paths

        assert paths.data_dir() == root / "data"
        from cashu.core.mcp.tools.investments_proposals import (
            ProposalError,
            ToolError,
            _existing_rule_ids,
            _render_rule,
            _rule_entry,
            check_resulting,
            merge_rule,
        )
        from cashu.modules.investments.strategy import load_strategy

        renders = []
        texts = [
            "plain text",
            "a: b",
            "yes",
            "two\nlines",
            "CR\rvalue",
            "tab\tvalue",
            "NEL\u0085value",
            "LINE\u2028value",
            "PARA\u2029value",
            "delete\x7fvalue",
            "apostrophe's text",
            "",
            "trailing\n",
            "leading\n\nvalue",
            " and ".join(["portfolio.cash_weight > 0.15"] * 45),
            " ".join(["synthetic message"] * 80),
        ]
        layouts = [
            "version: 1\n",
            "version: 1\nrules: [] # synthetic\n# footer\n",
            "version: 1\nrules:\n  # retain\n  - id: old\n    kind: cash_level\n\nother: null\n",
            "version: 1\nrules: [{id: old, kind: cash_level}]\n",
        ]
        for text in texts:
            entry = {
                "id": "new_rule",
                "kind": "custom",
                "params": {"scope": "portfolio", "when": "cash_weight > 0.1", "message": text},
            }
            renders.append(
                {
                    "entry": entry,
                    "rendered": _render_rule(entry, ""),
                    "merges": [
                        {"yaml": source, "expected": merge_rule(source, entry)}
                        for source in layouts
                    ],
                }
            )
        nested = {
            "id": "nested",
            "kind": "custom",
            "params": {
                "scope": "instrument",
                "when": "weight > 0.15",
                "filters": {"tags": ["alpha", "beta"], "kinds": ["equity", "etf"]},
                "items": [
                    {"name": "first", "threshold": 0.15},
                    {"name": "second", "threshold": 0.25},
                ],
            },
        }
        renders.append(
            {
                "entry": nested,
                "rendered": _render_rule(nested, ""),
                "merges": [
                    {"yaml": source, "expected": merge_rule(source, nested)} for source in layouts
                ],
            }
        )
        long_when = {
            "id": "long_when",
            "kind": "custom",
            "params": {"scope": "portfolio", "when": " and ".join(["cash_weight > 0.15"] * 55)},
        }
        renders.append(
            {
                "entry": long_when,
                "rendered": _render_rule(long_when, ""),
                "merges": [
                    {"yaml": source, "expected": merge_rule(source, long_when)}
                    for source in layouts
                ],
            }
        )
        entry_cases = []
        for kind, params, ids in [
            (" cash_level ", {"max_weight": 0.2}, []),
            ("cash_level", {"id": "agent_cash_level_1", "max_weight": 0.2}, ["agent_cash_level_1"]),
            ("custom", {"when": True, "scope": None, "id": []}, []),
            (
                "cash_weight > 0",
                {"scope": "portfolio", "severity": "warning", "cooldown_days": 7},
                [],
            ),
            ("\u0085cash_level\u0085", {"id": "\u0085synthetic\u0085"}, []),
        ]:
            try:
                entry, expression = _rule_entry(kind, params, set(ids))
                expected = {"ok": True, "entry": entry, "expression": expression}
            except ToolError as error:
                expected = {"ok": False, "message": str(error)}
            entry_cases.append({"kind": kind, "params": params, "ids": ids, "expected": expected})
        base = "version: 1\nbase_currency: PLN\nbuckets: [{id: cash, match: {asset_class: cash}}]\nallocation: {targets: {cash: 1.0}}\nrules: []\n"
        assert load_strategy(base).config is not None
        old = merge_rule(base, {"id": "old_bad", "kind": "not_a_kind"})
        validations = []
        for before, after, own in [
            (base, base, None),
            (old, old, None),
            (base, old, None),
            (base, old, "old_bad"),
            (base, base.replace("version: 1", "version: 99"), None),
            (base, merge_rule(base, long_when), "long_when"),
        ]:
            try:
                warnings = check_resulting(
                    load_strategy(after), load_strategy(before), new_rule_id=own
                )
                expected = {"ok": True, "warnings": warnings}
            except ProposalError as error:
                expected = {
                    "ok": False,
                    "code": getattr(error, "code", None),
                    "message": str(error),
                }
            validations.append({"before": before, "after": after, "own": own, "expected": expected})
        result = {
            "renders": renders,
            "entries": entry_cases,
            "validations": validations,
            "ids": [
                {"yaml": source, "expected": sorted(_existing_rule_ids(source))}
                for source in layouts
            ],
        }
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        encoded = subprocess.run(
            ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
            input=json.dumps(result, ensure_ascii=True, indent=2) + "\n",
            text=True,
            capture_output=True,
            check=True,
            cwd=REPO,
        ).stdout
        if options.check:
            assert TARGET.read_text() == encoded, "proposal rule fixture is stale"
        else:
            TARGET.write_text(encoded)
        print(
            f"proposal rule vectors: {len(renders)} renders, {len(entry_cases)} entries, {len(validations)} validation cases"
        )


if __name__ == "__main__":
    main()
