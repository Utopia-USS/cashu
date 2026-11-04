"""Actual Python research projections and note-to-plan writes over isolated invented data."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/mcp/src/tools/fixtures/research.json"
NOW = dt.datetime(2026, 11, 1, 12, 0, 0, 123000, tzinfo=dt.UTC)
NOTE = {
    "kind": "news",
    "polarity": "negative",
    "strength": 2,
    "thesis_relation": "invalidates",
    "thesis_field": "thesis",
    "title": "Zakończono program współpracy operacyjnej",
    "summary": "Spółka zakończyła program współpracy, który stanowił podstawę opisanej tezy.",
    "sources": [
        {
            "url": "https://example.com/synthetic-disclosure",
            "publisher": "Synthetic filings",
            "published_at": "2026-11-01",
        }
    ],
}
TOPIC = {
    "segment": "energy",
    "thesis": "Podaż pozostaje ograniczona przez czas budowy nowych mocy.",
}
MARKET_VIEW = {
    "segment": "energy",
    "assessment": "Wykorzystanie mocy jest wysokie, a nowe projekty potrzebują czasu.",
    "outlook": "Według raportu popyt na energię wzrośnie o 5% do 2028 r.; ryzykiem pozostają ograniczenia podaży.",
    "sources": NOTE["sources"],
}


def generate(root: Path):
    root = root.resolve()
    os.environ.update(
        HOME=str(root / "home"),
        CASHU_DATA_DIR=str(root / "data"),
        CASHU_TESTING="1",
        CASHU_AUTO_DAILY="0",
        CASHU_PRICE_REFRESH="0",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_LEGACY_DATA_DIR=str(root / "legacy"),
        CASHU_LAUNCH_AGENTS_DIR=str(root / "LaunchAgents"),
        CASHU_APP_BUNDLE="none",
        CASHU_DATABASE_URL=f"sqlite:///{root / 'data' / 'cashu.db'}",
        PYTHON_KEYRING_BACKEND="keyring.backends.fail.Keyring",
        CASHU_LANG="pl",
    )
    sys.path.insert(0, str(REPO / "parity/python/oracle/tests/investments/persistence"))
    from invp_support import HEADER, add_account, import_file, make_profile
    from sqlmodel import select

    from cashu.core import paths
    from cashu.core.db import get_session, init_db
    from cashu.core.mcp import labels as L
    from cashu.core.mcp.redaction import Redactor, leak_check
    from cashu.core.mcp.registry import ToolContext, ToolError
    from cashu.core.mcp.tools import research as tools
    from cashu.core.profiles import Profile
    from cashu.modules.investments import models
    from cashu.modules.investments.research import views
    from cashu.modules.investments.service import files
    from cashu.modules.investments.store import convert, instruments, transactions

    assert paths.data_dir().resolve() == root / "data"
    # Inject the existing utcnow service seam; timestamps and financial dates are not rewritten.
    for name, module in list(sys.modules.items()):
        if name.startswith("cashu.") and hasattr(module, "utcnow"):
            module.utcnow = lambda: NOW
    init_db()

    def redact(tree, privacy, guard=None):
        redactor = Redactor(privacy, guard)
        result = redactor.apply(tree)
        leak_check(
            result, strict=redactor.strict, isins=redactor.isins, non_money=redactor.non_money
        )
        return result

    exposure = []
    for label, rows, owned in [
        (
            "ties_and_missing",
            [
                ("a", 0.1, "equity", "EU", "energy"),
                ("b", 0.2, "equity", "US", "industry"),
                ("c", 0.3, "etf", "EU", "energy"),
                ("d", None, None, None, None),
            ],
            [],
        ),
        (
            "private_classification",
            [
                ("a", 0.5, "equity", "EU", "energy"),
                ("b", 0.5, "property", "Private place", "Private industry"),
            ],
            ["b"],
        ),
        (
            "stable_equal_order",
            [("a", 0.5, "etf", "US", None), ("b", 0.5, "equity", "EU", None)],
            [],
        ),
    ]:
        positions = [
            {
                "instrument": {"id": i, "asset_class": asset, "region": region, "sector": sector},
                "weight": weight,
            }
            for i, weight, asset, region, sector in rows
        ]
        exposure.append(
            {
                "label": label,
                "positions": [
                    {
                        "instrument": i,
                        "weight": weight,
                        "assetClass": asset,
                        "region": region,
                        "sector": sector,
                    }
                    for i, weight, asset, region, sector in rows
                ],
                "owned": owned,
                "expected": {
                    privacy: redact(tools._exposure(positions, set(owned)), privacy)
                    for privacy in ("strict", "amounts")
                },
            }
        )

    for case in exposure:
        case["wire"] = {
            privacy: json.dumps(data, sort_keys=True, ensure_ascii=False)
            for privacy, data in case["expected"].items()
        }
    workflow = {}
    for privacy in ("strict", "amounts"):
        pid, slug = make_profile(f"Anna Nowak {privacy}")
        aid = add_account(pid, name="Synthetic broker")
        import_file(
            pid,
            aid,
            (
                HEADER
                + "\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n1,txn,2026-01-01,,buy,B,ABC,PLABC0000016,Synthetic quoted holding,XWAR,10,100,PLN,1000,0,0,-1000,PLN,,,generic_csv\n"
            ).encode(),
        )
        files.write_text_private(
            files.strategy_yaml_path(slug),
            "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n",
        )
        with get_session() as session:
            profile = session.get(Profile, pid)
            iid = next(
                convert.pk(txn.instrument_id)
                for txn in transactions.transactions(session, pid)
                if txn.instrument_id is not None
            )
            assert profile is not None and iid is not None
            session.add(
                models.InvThesis(
                    profile_id=pid,
                    instrument_id=iid,
                    entry_type="trend",
                    thesis="Popyt utrzymuje się przez cykl.",
                    reviewed_at=NOW,
                    created_at=NOW,
                    updated_at=NOW,
                    core_changed_at=NOW,
                )
            )
            classification = instruments.set_plan(session, iid, "buy", profile_id=pid, held=True)
            classification.asset_class = "equity"
            session.add(classification)
            session.flush()
            ctx = ToolContext(session, profile, privacy, NOW.date())
            started = redact(tools.start_research_run(ctx), privacy, ctx.guard)
            added = redact(
                tools.add_research_note(ctx, instrument="ABC", run_id=started["run_id"], **NOTE),
                privacy,
                ctx.guard,
            )
            finished = redact(
                tools.finish_research_run(ctx, started["run_id"], counts={"sources_checked": 1}),
                privacy,
                ctx.guard,
            )
            errors = {}
            neutral = {
                key: value
                for key, value in NOTE.items()
                if key not in ("thesis_relation", "thesis_field")
            }
            for label, scope in (
                ("no_scope", {}),
                ("segment_only", {"segment": "energy", "instrument": "ABC"}),
            ):
                try:
                    tools.add_research_note(ctx, **neutral, **scope)
                except ToolError as error:
                    errors[label] = {
                        "error_kind": error.kind,
                        **redact({"error": L.text(str(error))}, "strict", ctx.guard),
                    }
                else:
                    raise AssertionError("synthetic refusal unexpectedly wrote")
            drafted = redact(tools.upsert_topic_thesis(ctx, **TOPIC), privacy, ctx.guard)
            try:
                tools.set_topic_market_view(
                    ctx, segment="energy", assessment="", outlook="", sources=[]
                )
            except ToolError as error:
                errors["invalid_view"] = {
                    "error_kind": error.kind,
                    **redact({"error": L.text(str(error))}, "strict", ctx.guard),
                }
            else:
                raise AssertionError("synthetic invalid view unexpectedly wrote")
            market_view = redact(
                tools.set_topic_market_view(ctx, **MARKET_VIEW), privacy, ctx.guard
            )
            segment = redact(tools.set_instrument_segment(ctx, "ABC", "energy"), privacy, ctx.guard)
            listed = redact(tools.research_notes(ctx), privacy, ctx.guard)
            notes = session.exec(
                select(models.InvResearchNote).where(models.InvResearchNote.profile_id == pid)
            ).all()
            signals = session.exec(
                select(models.InvSignal).where(models.InvSignal.profile_id == pid)
            ).all()
            assert len(notes) == 1 and notes[0].instrument_id == iid
            refs = {
                "run_id": started["run_id"],
                "note_id": added["note_id"],
                "instrument_id": iid,
                "signal_id": added["signal"]["signal_id"],
            }

            def normalized(tree, refmap=refs):
                if isinstance(tree, list):
                    return [normalized(x, refmap) for x in tree]
                if isinstance(tree, dict):
                    return {
                        key: (
                            key.removesuffix("_id")
                            if value is not None and key in refmap and value == refmap[key]
                            else normalized(value, refmap)
                        )
                        for key, value in tree.items()
                    }
                return tree

            workflow[privacy] = {
                "errors": errors,
                "topic": normalized(drafted),
                "market_view": normalized(market_view),
                "segment": normalized(segment),
                "notes": normalized(listed),
                "start": normalized(started),
                "add": normalized(added),
                "finish": normalized(finished),
                "state": {
                    "notes": len(notes),
                    "signals": sorted(
                        [{"rule": s.rule_id, "status": s.status} for s in signals],
                        key=lambda x: x["rule"],
                    ),
                    "health": views.health_by_instrument(session, pid, {iid}, NOW)[iid][0].state,
                },
            }
            workflow[privacy]["wire"] = {
                name: json.dumps(workflow[privacy][name], sort_keys=True, ensure_ascii=False)
                for name in ("start", "add", "finish", "topic", "market_view", "segment", "notes")
            }
    return {"exposure": exposure, "workflow": workflow}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-research-oracle-") as tmp:
        output = generate(Path(tmp))
    text = subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
        input=json.dumps(output, sort_keys=True, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout
    if args.check:
        if TARGET.read_text() != text:
            raise SystemExit("research oracle differs")
    else:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(text)
    print(
        f"research oracle: {len(output['exposure'])} exposure vectors; two isolated write/privacy cases"
    )


if __name__ == "__main__":
    main()
