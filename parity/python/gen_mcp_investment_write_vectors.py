"""Actual Python investment-write MCP outputs over isolated synthetic stores, never source data."""

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
TARGET = REPO / "packages/mcp/src/tools/fixtures/investmentWrites.json"
NOW = dt.datetime(2026, 11, 1, 12, 0, 0, 123000, tzinfo=dt.UTC)
YAML = "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"


def generate(root: Path):
    root = root.resolve()
    os.environ.update(
        HOME=str(root / "home"),
        CASHU_DATA_DIR=str(root / "data"),
        CASHU_TESTING="1",
        CASHU_AUTO_DAILY="0",
        CASHU_PRICE_REFRESH="0",
        CASHU_LANG="pl",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_LEGACY_DATA_DIR=str(root / "legacy"),
        CASHU_LAUNCH_AGENTS_DIR=str(root / "LaunchAgents"),
        CASHU_APP_BUNDLE="none",
        CASHU_DATABASE_URL=f"sqlite:///{root / 'data' / 'cashu.db'}",
        PYTHON_KEYRING_BACKEND="keyring.backends.fail.Keyring",
    )
    sys.path.insert(0, str(REPO / "tests/investments/persistence"))
    from invp_support import HEADER, add_account, import_file, make_profile
    from sqlmodel import select

    from cashu.core import paths
    from cashu.core.db import get_session, init_db
    from cashu.core.mcp import labels as L
    from cashu.core.mcp.redaction import Redactor, leak_check
    from cashu.core.mcp.registry import ToolContext, ToolError
    from cashu.core.mcp.tools import alerts as alert_tools
    from cashu.core.mcp.tools import investments as tools
    from cashu.core.mcp.tools.investments_proposals import _diff_stats
    from cashu.core.profiles import Profile
    from cashu.modules.investments import models
    from cashu.modules.investments.service import alerts, files, plans, watchlist
    from cashu.modules.investments.store import convert, instruments, journal, transactions

    # Import actual side-effect modules before injecting their existing clock seams.
    assert alerts and plans and watchlist and instruments and journal
    assert paths.data_dir().resolve() == root / "data"
    for name, module in list(sys.modules.items()):
        if name.startswith("cashu.") and hasattr(module, "utcnow"):
            module.utcnow = lambda: NOW
    init_db()
    output = {}
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
        files.write_text_private(files.strategy_yaml_path(slug), YAML)
        with get_session() as session:
            profile = session.get(Profile, pid)
            iid = next(
                convert.pk(txn.instrument_id)
                for txn in transactions.transactions(session, pid)
                if txn.instrument_id is not None
            )
            assert profile and iid
            ctx = ToolContext(session, profile, privacy, NOW.date())
            refs = {"instrument_id": iid}
            responses = {}

            def call(name, fn, *args, _privacy=privacy, _ctx=ctx, _responses=responses, **kwargs):
                redactor = Redactor(_privacy, _ctx.guard)
                value = redactor.apply(fn(_ctx, *args, **kwargs))
                leak_check(
                    value,
                    strict=redactor.strict,
                    isins=redactor.isins,
                    non_money=redactor.non_money,
                )
                _responses[name] = value
                return value

            call("recommend", tools.set_recommendation, "ABC", "buy", "Current source facts")
            call("coverage", tools.set_recommendations, "held", [])
            thesis = call(
                "thesis", tools.upsert_thesis, "ABC", "trend", "Popyt utrzymuje się przez cykl."
            )
            refs["thesis_id"] = thesis["thesis_id"]
            call(
                "thesis_update",
                tools.upsert_thesis,
                "ABC",
                "trend",
                "Popyt utrzymuje się przez cykl.",
                exit_plan="Review at the next disclosure",
            )
            alert = call(
                "add_alert",
                alert_tools.add_alert,
                "price_below",
                {"level": 90},
                "negative",
                "info",
                "Synthetic price condition",
                instrument="ABC",
                tag="cena",
            )
            refs["alert_id"] = alert["alert"]["alert_id"]
            call("alerts", alert_tools.alerts)
            call("mute", alert_tools.mute_alert, refs["alert_id"])
            watched = call(
                "add_watch", alert_tools.add_to_watchlist, "ABC", note="Synthetic watch note"
            )
            refs["item_id"] = watched["item"]["item_id"]
            call("watchlist", alert_tools.watchlist)
            call("remove_watch", alert_tools.remove_from_watchlist, refs["item_id"])
            signal = models.InvSignal(
                profile_id=pid,
                rule_id="synthetic_rule",
                kind="synthetic",
                dedup_key=f"synthetic_rule|i:{iid}",
                severity="info",
                polarity="neutral",
                status="active",
                message="Synthetic journal signal",
                instrument_id=iid,
                first_seen_at=NOW,
                last_seen_at=NOW,
            )
            session.add(signal)
            session.flush()
            refs["signal_id"] = signal.id
            decided = call("decision", tools.record_decision, signal.id, "held", "Review recorded")
            refs["decision_id"] = decided["decision_id"]
            call("strategy_dry", tools.propose_strategy, YAML, dry_run=True)
            call("strategy_invalid", tools.propose_strategy, "version: 99\n", dry_run=True)
            proposal = call("strategy", tools.propose_strategy, YAML, reason="Synthetic proposal")
            strategy_id = proposal["proposal_id"]
            call(
                "rule_dry",
                tools.propose_custom_rule,
                "cash_level",
                {"max_weight": 0.5},
                dry_run=True,
            )
            call("rule_invalid", tools.propose_custom_rule, "cash_weight >", dry_run=True)
            rule = call(
                "rule",
                tools.propose_custom_rule,
                "cash_level",
                {"max_weight": 0.5},
                reason="Synthetic rule proposal",
            )
            rule_id = rule["proposal_id"]

            def normalized(tree, refmap=refs, strategy_proposal=strategy_id, rule_proposal=rule_id):
                if isinstance(tree, list):
                    return [normalized(value) for value in tree]
                if isinstance(tree, dict):
                    return {
                        key: (
                            key.removesuffix("_id")
                            if key in refmap and value == refmap[key]
                            else "strategy_proposal"
                            if key == "proposal_id" and value == strategy_proposal
                            else "rule_proposal"
                            if key == "proposal_id" and value == rule_proposal
                            else normalized(value)
                        )
                        for key, value in tree.items()
                    }
                return tree

            state = {
                "recommendation": instruments.load(session, [iid], profile_id=pid)[iid].plan,
                "theses": len(
                    session.exec(
                        select(models.InvThesis).where(models.InvThesis.profile_id == pid)
                    ).all()
                ),
                "decisions": len(
                    session.exec(
                        select(models.InvDecision).where(models.InvDecision.profile_id == pid)
                    ).all()
                ),
                "signal_status": signal.status,
            }
            output[privacy] = {"responses": normalized(responses), "state": state}
            output[privacy]["wire"] = json.dumps(
                normalized(responses), sort_keys=True, ensure_ascii=False
            )
            errors = {}

            def refused(label, scope, updates, _ctx=ctx, _errors=errors):
                try:
                    tools.set_recommendations(_ctx, scope, updates)
                except ToolError as error:
                    _errors[label] = {
                        "error_kind": error.kind,
                        **Redactor("strict", _ctx.guard).apply({"error": L.text(str(error))}),
                    }
                else:
                    raise AssertionError("synthetic recommendation refusal unexpectedly wrote")

            changed = {"instrument": "ABC", "recommendation": "buy", "reason": "Current facts"}
            refused("duplicate", "held", [changed, changed])
            refused("outside", "watchlist", [changed])
            refused("enum", "held", [{**changed, "recommendation": "sell"}])
            for symbol in ("OTHER", "THIRD"):
                inst = models.InvInstrument(
                    name=f"{symbol} public",
                    symbol=symbol,
                    currency="PLN",
                    asset_class="equity",
                    valuation_mode="market",
                )
                session.add(inst)
                session.flush()
                session.add(
                    models.InvWatchlistItem(
                        profile_id=pid, instrument_id=inst.id, source="agent", added_at=NOW
                    )
                )
            session.flush()
            reducing = {
                "instrument": "OTHER",
                "recommendation": "reduce",
                "reason": "Current facts",
            }
            refused("coverage_before_held", "watchlist", [reducing])
            refused(
                "held_after_coverage",
                "watchlist",
                [
                    reducing,
                    {"instrument": "THIRD", "recommendation": "hold", "reason": "Current facts"},
                ],
            )
            output[privacy]["errors"] = errors
            reason_vectors = []
            for label, reason, plan in [
                ("astral_boundary", "🙂" * 280, "buy"),
                ("astral_over", "🙂" * 281, "buy"),
                ("nel", "  Current\u0085source\tfacts  ", "buy"),
                ("raw_vs_collapsed", "A" + " " * 300 + "B", "buy"),
                ("empty", "", "buy"),
                ("null_reason", None, "buy"),
                ("clear_plan", "Discarded reason", None),
            ]:
                accepted = True
                try:
                    instruments.set_plan(
                        session, iid, plan, profile_id=pid, held=True, reason=reason
                    )
                except instruments.PlanError:
                    accepted = False
                stored = session.exec(
                    select(models.InvProfileInstrument).where(
                        models.InvProfileInstrument.profile_id == pid,
                        models.InvProfileInstrument.instrument_id == iid,
                    )
                ).one()
                reason_vectors.append(
                    {
                        "label": label,
                        "reason": reason,
                        "plan": plan,
                        "expected": {
                            "accepted": accepted,
                            "reason": stored.plan_reason,
                            "plan": stored.plan,
                        },
                    }
                )
            output[privacy]["reason_vectors"] = reason_vectors
    output["diffs"] = [
        {"old": old, "next": new, "expected": Redactor("amounts").apply(_diff_stats(old, new))}
        for old, new in [
            (None, "alpha\nbeta\n"),
            ("--literal\nx\n", "++literal\ny\n"),
            ("x\n" * 210 + "keep\n", "keep\n" + "x\n" * 210),
            ("alpha\u2028beta\r\ngamma\n", "alpha\nbeta\ngamma\n"),
        ]
    ]
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-mcp-writes-oracle-") as directory:
        output = generate(Path(directory))
    text = subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
        input=json.dumps(output, sort_keys=True, ensure_ascii=False, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout
    if args.check:
        if TARGET.read_text() != text:
            raise SystemExit("investment-write oracle differs")
    else:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(text)
    print("investment-write oracle: two synthetic privacy workflows")


if __name__ == "__main__":
    main()
