"""Investments proposals: ``strategy``, ``custom_rule`` and ``import`` (kinds for ``core.proposals``), the
MCP write tools that create them and ``validate_import``.

- ``propose_strategy``: validated with the strategy loader; stored with the sha256 of the current files.
  Approving writes strategy.yaml (+ .md when given) and records a new version; it fails when the files
  changed since the proposal (an edit in between would be overwritten).
- ``propose_custom_rule``: a built-in kind with params, or a custom expression (compiled with the
  expression compiler first, for an exact column). The rule entry is merged into the current
  strategy.yaml text (comments kept; appended to the ``rules:`` block), the merged file is validated,
  and the rule is backtested: evaluated as of weekly (longer histories: evenly spaced, at most 260)
  dates over the profile's history. Approving merges it into the then-current file the same way.
- ``propose_import``: previews the file (finanse format, generic CSV + mapping, or the output of an
  approved converter script) and stores the export in ``<data dir>/imports/<slug>/.proposals/``.
  Approving re-runs the preview (and the converter, hash-checked) and commits it.

What the agent gets back is labelled like any tool answer: counts, kinds, rows and dates; the diff of
the owner's files is shown only in the app (``detail``), the agent gets line counts.
"""

from __future__ import annotations

import datetime as dt
import difflib
import hashlib
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import yaml as pyyaml
from sqlmodel import Session

from finanse.core import proposals
from finanse.core.agent_models import Proposal
from finanse.core.db import get_session
from finanse.core.models import Profile
from finanse.core.proposals import ProposalError, ProposalKind, Staged

from .. import labels as L
from ..registry import ToolContext, ToolError
from . import converters
from .exports import checked_local_file, checked_path, inside
from .investments import owner_named

MAX_BACKTEST_POINTS = 260
MAX_MAPPING_BYTES = 256 * 1024
STRATEGY_LOCK_WAIT = 30.0  # seconds an approval waits for a running daily check (then busy)

# --------------------------------------------------------------------------- #
# Shared
# --------------------------------------------------------------------------- #


def _digest(yaml_text: str | None, md_text: str | None) -> str:
    return hashlib.sha256(((yaml_text or "") + "\0" + (md_text or "")).encode("utf-8")).hexdigest()


def _current_files(slug: str) -> tuple[str | None, str | None]:
    from finanse.modules.investments.service import strategy as strategy_files

    yaml_text, md_text, error = strategy_files.read_files(slug)
    if error is not None:
        raise ToolError("the current strategy files cannot be read", "strategy_unreadable")
    return yaml_text, md_text


def _issue(i) -> dict:
    return {
        "severity": L.category(i.severity.value),
        "path": L.text(i.path),
        "message": L.text(i.message),
        "line": L.count(i.line),
        "column": L.count(i.column),
    }


def _diff_stats(old: str | None, new: str | None) -> dict:
    added = removed = 0
    for line in difflib.unified_diff(
        (old or "").splitlines(), (new or "").splitlines(), lineterm="", n=0
    ):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return {"lines_added": L.count(added), "lines_removed": L.count(removed)}


def _unified(old: str | None, new: str | None, name: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            (old or "").splitlines(),
            (new or "").splitlines(),
            fromfile=f"{name} (current)",
            tofile=f"{name} (proposed)",
            lineterm="",
        )
    )


def _strategy_change(
    profile: Profile,
    base: tuple[str | None, str | None],
    yaml_text: str,
    md_text: str | None,
    result: dict,
) -> Staged:
    """Approving a strategy change (F5 R8): the new version is recorded in the transaction that marks
    the proposal approved (``record``), the files are replaced only after that commit, both written to
    temp names first and renamed together (``publish``); a failed write removes the version again
    (``undo``) and leaves the old files. Held under the daily-check lock, so the daily check never
    reads the files between the version and the write. ``md_text`` None keeps strategy.md."""
    from finanse.modules.investments.service import files
    from finanse.modules.investments.service.daily import LOCK_NAME

    base_yaml, base_md = base
    md_final = md_text if md_text is not None else base_md
    created: list[int] = []

    def record(session: Session) -> dict:
        current_yaml, current_md, err = _read_quiet(profile.slug)
        if err is not None or _digest(current_yaml, current_md) != _digest(base_yaml, base_md):
            raise ProposalError(
                "the strategy files changed while approving; ask for a new proposal",
                "base_changed",
            )
        row, new = _record_version(session, profile.id, yaml_text, md_final)
        if new:
            created.append(row.id)
        return {"version": row.version, "state": row.state}

    def publish() -> None:
        writes = [(files.strategy_yaml_path(profile.slug), yaml_text, base_yaml)]
        if md_text is not None:
            writes.append((files.strategy_md_path(profile.slug), md_text, base_md))
        replace_files(writes)

    def undo(session: Session) -> None:
        from finanse.modules.investments.models import InvStrategyVersion

        for version_id in created:
            row = session.get(InvStrategyVersion, version_id)
            if row is not None:
                session.delete(row)
        session.flush()

    return Staged(
        result,
        record=record,
        publish=publish,
        undo=undo,
        lock=LOCK_NAME,
        lock_wait=STRATEGY_LOCK_WAIT,
    )


def _record_version(session: Session, profile_id: int, yaml_text: str, md_text: str | None):
    """(version row, created): a new ``inv_strategy_versions`` row for the text, unless the newest one
    already holds it. Same digest and state as ``service.strategy.load(record=True)``."""
    from finanse.modules.investments.models import InvStrategyVersion
    from finanse.modules.investments.service import strategy as strategy_files
    from finanse.modules.investments.strategy import load_strategy

    digest = _digest(yaml_text, md_text)
    latest = strategy_files.latest_version(session, profile_id)
    if latest is not None and latest.sha256 == digest:
        return latest, False
    result = load_strategy(yaml_text, md_text)
    row = InvStrategyVersion(
        profile_id=profile_id,
        version=(latest.version + 1) if latest is not None else 1,
        sha256=digest,
        yaml_text=yaml_text,
        md_text=md_text,
        state="valid" if result.config else "partial" if result.partial else "invalid",
        issues=[strategy_files.issue_dict(i) for i in result.issues],
    )
    session.add(row)
    session.flush()
    return row, True


def replace_files(writes: list[tuple[Path, str, str | None]]) -> None:
    """Replace several owner files together: each ``(path, new text, old text)`` is written to a temp
    file first (0600), then they are renamed in order. A failure removes the temp files and puts any
    file already replaced back to its old text (or removes it when it did not exist), then raises."""
    from finanse.modules.investments.service import files

    temps: list[tuple[Path, Path, str | None]] = []
    done: list[tuple[Path, str | None]] = []
    try:
        for path, text, old in writes:
            files.ensure_dir(path.parent)
            tmp = path.with_name(f".{path.name}.approving")
            tmp.write_bytes(text.encode("utf-8"))
            tmp.chmod(0o600)
            temps.append((tmp, path, old))
        for tmp, path, old in temps:
            tmp.replace(path)
            done.append((path, old))
    except BaseException:
        for tmp, _path, _old in temps:
            tmp.unlink(missing_ok=True)
        for path, old in reversed(done):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                files.write_text_private(path, old)
        raise


def _inactive_ids(result) -> set[str]:
    if result is None:
        return set()
    return {r.rule_id or f"rules[{r.index}]" for r in result.inactive_rules}


def check_resulting(result, before=None, *, new_rule_id: str | None = None) -> list[dict]:
    """Validate a resulting strategy the way the daily check uses it: usable when it is valid or
    partial (broken rule entries inactive, the others run). Raises ``ProposalError`` (with a code) when
    it is unusable, when the proposed rule itself is broken, or when the change makes other rules
    inactive; rules that were already inactive ``before`` are returned as warnings."""
    if result.config is None and result.partial is None:
        errors = "; ".join(str(i) for i in result.issues if i.is_error)[:500]
        raise ProposalError(
            f"the resulting strategy does not validate: {errors}", "invalid_strategy"
        )
    now = _inactive_ids(result)
    if new_rule_id is not None and new_rule_id in now:
        rule = next(r for r in result.inactive_rules if (r.rule_id or "") == new_rule_id)
        problems = "; ".join(str(i) for i in rule.issues)[:500]
        raise ProposalError(
            f"the proposed rule {new_rule_id} does not validate: {problems}", "rule_invalid"
        )
    new = sorted(now - _inactive_ids(before) - ({new_rule_id} if new_rule_id else set()))
    if new:
        raise ProposalError(
            f"the change makes rule(s) inactive: {', '.join(new)}", "rules_made_inactive"
        )
    return [
        {
            "code": "inactive_rule",
            "rule_id": rule_id,
            "message": f"rule {rule_id} was already inactive before this change; fix it in "
            "strategy.yaml",
        }
        for rule_id in sorted(now)
    ]


# --------------------------------------------------------------------------- #
# Strategy
# --------------------------------------------------------------------------- #


def propose_strategy(
    ctx: ToolContext, yaml_text: str, md: str | None, reason: str | None, *, dry_run: bool = False
) -> dict:
    from finanse.modules.investments.strategy import load_strategy

    if not yaml_text.strip():
        raise ToolError("yaml is empty")
    result = load_strategy(yaml_text, md)
    current_yaml, current_md = _current_files(ctx.profile.slug)
    before = load_strategy(current_yaml, current_md) if current_yaml is not None else None
    warnings: list[dict] = []
    problem = None
    try:
        warnings = check_resulting(result, before)
    except ProposalError as e:
        problem = e
    valid = problem is None
    out: dict[str, Any] = {
        "valid": L.flag(valid),
        "state": L.category(
            "valid" if result.config else "partial" if result.partial else "invalid"
        ),
        "issues": [_issue(i) for i in result.issues],
        "warnings": [
            {"code": L.category(w["code"]), "rule": L.text(w["rule_id"])} for w in warnings
        ],
        "yaml_diff": _diff_stats(current_yaml, yaml_text),
        "md_diff": _diff_stats(current_md, md) if md is not None else None,
        "stored": L.flag(False),
        "dry_run": L.flag(dry_run),
    }
    config = result.config or result.partial
    if config is not None:
        out["rules"] = L.count(len(config.rules))
        out["buckets"] = [L.category(b.id) for b in config.allocation.buckets]
    if not valid:
        out["error_code"] = L.category(problem.code)
        out["note"] = L.text("not stored: fix the errors (line / column above) and propose again")
        return out
    if dry_run:
        return out
    row = proposals.create(
        ctx.session,
        ctx.profile,
        "strategy",
        {
            "yaml": yaml_text,
            "md": md,
            "base_sha256": _digest(current_yaml, current_md),
            "issues": [
                {
                    "severity": i.severity.value,
                    "path": i.path,
                    "message": i.message,
                    "line": i.line,
                    "column": i.column,
                }
                for i in result.issues
            ],
        },
        summary=f"Strategy: {len(config.rules)} rules, {len(config.allocation.buckets)} buckets",
        summary_params={
            "rules": len(config.rules),
            "buckets": len(config.allocation.buckets),
            "inactive_rules": len(warnings),
        },
        reason=reason,
    )
    out["stored"] = L.flag(True)
    out["proposal_id"] = L.ref(row.id)
    out["note"] = L.text("stored as a proposal; the owner approves it in the app (Inwestycje)")
    return out


def _strategy_detail(session: Session, profile: Profile, row: Proposal) -> dict:
    current_yaml, current_md, _err = _read_quiet(profile.slug)
    p = row.payload or {}
    return {
        "diff": {
            "yaml": _unified(current_yaml, p.get("yaml"), "strategy.yaml"),
            "md": _unified(current_md, p.get("md"), "strategy.md")
            if p.get("md") is not None
            else None,
        },
        "base_changed": _digest(current_yaml, current_md) != p.get("base_sha256"),
    }


def _read_quiet(slug: str):
    from finanse.modules.investments.service import strategy as strategy_files

    return strategy_files.read_files(slug)


def _strategy_apply(profile: Profile, row: Proposal) -> dict:
    from finanse.modules.investments.strategy import load_strategy

    p = row.payload or {}
    current_yaml, current_md, err = _read_quiet(profile.slug)
    if err is not None:
        raise ProposalError("the current strategy files cannot be read", "strategy_unreadable")
    if _digest(current_yaml, current_md) != p.get("base_sha256"):
        raise ProposalError(
            "the strategy files changed since this proposal was made; ask for a new proposal",
            "base_changed",
        )
    before = load_strategy(current_yaml, current_md) if current_yaml is not None else None
    md = p.get("md") if p.get("md") is not None else current_md
    warnings = check_resulting(load_strategy(p.get("yaml") or "", md), before)
    return _strategy_change(
        profile, (current_yaml, current_md), p["yaml"], p.get("md"), {"warnings": warnings}
    )


# --------------------------------------------------------------------------- #
# Custom rules
# --------------------------------------------------------------------------- #

_META = ("id", "severity", "cooldown_days")
_TOP_KEY = re.compile(r"^[A-Za-z_][\w-]*\s*:")


def _render_rule(entry: dict, indent: str) -> str:
    text = pyyaml.safe_dump(
        [entry], sort_keys=False, allow_unicode=True, default_flow_style=False, width=1000
    )
    return "".join(f"{indent}{line}\n" if line.strip() else "\n" for line in text.splitlines())


def merge_rule(yaml_text: str, entry: dict) -> str:
    """Append ``entry`` to the top-level ``rules:`` block of ``yaml_text`` (comments and layout kept);
    a missing block is added at the end; an inline non-empty flow list is rewritten by PyYAML."""
    lines = yaml_text.splitlines()
    start = next((i for i, ln in enumerate(lines) if re.match(r"^rules\s*:", ln)), None)
    if start is None:
        body = yaml_text if yaml_text.endswith("\n") or not yaml_text else yaml_text + "\n"
        return body + "rules:\n" + _render_rule(entry, "  ")
    rest = lines[start].split(":", 1)[1].split("#", 1)[0].strip()
    if rest in ("[]", ""):
        if rest == "[]":
            lines[start] = "rules:"
        end = start + 1
        indent = None
        last_content = start
        while end < len(lines):
            ln = lines[end]
            stripped = ln.strip()
            if stripped and not stripped.startswith("#"):
                if not ln.startswith((" ", "\t")) and not ln.startswith("-"):
                    break
                if indent is None and stripped.startswith("- "):
                    indent = ln[: len(ln) - len(ln.lstrip())]
                last_content = end
            end += 1
        rendered = (
            _render_rule(entry, indent if indent is not None else "  ").rstrip("\n").split("\n")
        )
        merged = lines[: last_content + 1] + rendered + lines[last_content + 1 :]
        return "\n".join(merged) + "\n"
    doc = pyyaml.safe_load(yaml_text) or {}
    doc.setdefault("rules", [])
    doc["rules"] = list(doc["rules"] or []) + [entry]
    return pyyaml.safe_dump(doc, sort_keys=False, allow_unicode=True)


def _rule_entry(
    kind_or_expression: str, params: dict, existing_ids: set[str]
) -> tuple[dict, str | None]:
    """The YAML rule entry and, for a custom rule, its expression."""
    from finanse.modules.investments.rules import RuleCatalog

    catalog = RuleCatalog.built_in()
    params = dict(params)
    meta = {k: params.pop(k) for k in _META if k in params}
    text = kind_or_expression.strip()
    if text in catalog.kinds and text != "custom":
        kind, expression, rule_params = text, None, params
    else:
        kind = "custom"
        if text == "custom":
            expression = str(params.pop("when", "") or "")
        else:
            expression = text
            params.pop("when", None)
        rule_params = {"scope": params.pop("scope", "portfolio"), "when": expression, **params}
    rule_id = str(meta.get("id") or "").strip()
    if not rule_id:
        base = re.sub(r"[^a-z0-9_]+", "_", f"agent_{kind}").strip("_")
        n = 1
        while f"{base}_{n}" in existing_ids:
            n += 1
        rule_id = f"{base}_{n}"
    if rule_id in existing_ids:
        raise ToolError(f"a rule with id {rule_id} already exists; choose another id")
    entry: dict[str, Any] = {"id": rule_id, "kind": kind}
    if "severity" in meta:
        entry["severity"] = meta["severity"]
    if "cooldown_days" in meta:
        entry["cooldown_days"] = meta["cooldown_days"]
    if rule_params:
        entry["params"] = rule_params
    return entry, expression


def _existing_rule_ids(yaml_text: str) -> set[str]:
    try:
        doc = pyyaml.safe_load(yaml_text) or {}
    except pyyaml.YAMLError:
        return set()
    rules = doc.get("rules") if isinstance(doc, dict) else None
    return {str(r.get("id")) for r in rules or [] if isinstance(r, dict) and r.get("id")}


def _validate_rule(yaml_text: str, md: str | None, entry: dict, expression: str | None):
    """(merged yaml, load result, issues of the new rule) or raise ToolError for an unusable base."""
    from finanse.modules.investments.rules.expr import ExpressionError, compile_expression
    from finanse.modules.investments.strategy import load_strategy

    base = load_strategy(yaml_text, md)
    if base.config is None and base.partial is None:
        raise ToolError(
            "the current strategy has errors; fix them (strategy_status) before adding rules"
        )
    merged = merge_rule(yaml_text, entry)
    if expression is not None:
        scope = (entry.get("params") or {}).get("scope", "portfolio")
        try:
            compile_expression(expression, scope)
        except ExpressionError as e:
            return (
                merged,
                None,
                [
                    {
                        "severity": "error",
                        "path": "params.when",
                        "message": e.message,
                        "line": None,
                        "column": e.column,
                    }
                ],
            )
        except ValueError:
            return (
                merged,
                None,
                [
                    {
                        "severity": "error",
                        "path": "params.scope",
                        "message": "scope must be portfolio, instrument or bucket",
                        "line": None,
                        "column": None,
                    }
                ],
            )
    result = load_strategy(merged, md)
    count = len(_existing_rule_ids(yaml_text))
    prefix = f"rules[{count}]"
    own = [
        {
            "severity": i.severity.value,
            "path": i.path,
            "message": i.message,
            "line": i.line,
            "column": i.column,
        }
        for i in result.issues
        if i.path == prefix or i.path.startswith(prefix + ".") or i.path.startswith(prefix + "[")
    ]
    return merged, result, own


def backtest(ctx: ToolContext, spec, config) -> dict:
    """Evaluate one rule as of dates over the profile's history (see the module doc)."""
    from finanse.modules.investments.rules import Fired, RuleContext, RulesEngine, Skipped
    from finanse.modules.investments.service import portfolio
    from finanse.modules.investments.store import convert, transactions

    txns = transactions.transactions(ctx.session, ctx.profile_id)
    if not txns:
        return {"evaluated": 0, "note": "no transaction history yet"}
    start = min(t.trade_date for t in txns)
    end = ctx.today
    days = max(0, (end - start).days)
    step = max(7, math.ceil(days / MAX_BACKTEST_POINTS)) if days else 7
    dates = sorted({end - dt.timedelta(days=k * step) for k in range(days // step + 1)})
    engine = RulesEngine([spec])
    fired_dates: list[dt.date] = []
    fired_outcomes = 0
    episodes = 0
    scopes: Counter = Counter()
    skip_reasons: Counter = Counter()
    skipped_points = 0
    previous: set[str] = set()
    symbols: dict[str, str] = {}
    for day in dates:
        state = portfolio.build(ctx.session, ctx.profile, as_of=day, strategy=config)
        rctx = RuleContext.build(
            profile_id=convert.sid(ctx.profile_id),
            as_of=day,
            portfolio=state.valued,
            market=state.market,
            allocation=state.allocation,
            data=config.data,
            contributions=config.contributions,
        )
        outcomes = engine.evaluate(rctx)
        now_keys: set[str] = set()
        any_skip = False
        for o in outcomes:
            if isinstance(o, Fired):
                key = o.candidate.dedup_key
                now_keys.add(key)
                fired_outcomes += 1
                scopes[key] += 1
                if o.candidate.instrument_id:
                    inst = state.instruments.get(o.candidate.instrument_id)
                    mode = inst.valuation_mode.value if inst and inst.valuation_mode else None
                    if (
                        inst is not None
                        and inst.symbol
                        and not owner_named(inst.asset_class.value, mode, inst.isin)
                    ):
                        symbols[key] = inst.symbol
            elif isinstance(o, Skipped):
                any_skip = True
                skip_reasons[re.sub(r"\d", "#", o.reason or "")[:120]] += 1
        episodes += len(now_keys - previous)
        previous = now_keys
        if now_keys:
            fired_dates.append(day)
        if any_skip and not now_keys:
            skipped_points += 1
    return {
        "evaluated": len(dates),
        "step_days": step,
        "from": start,
        "to": end,
        "points_fired": len(fired_dates),
        "fired_outcomes": fired_outcomes,
        "episodes": episodes,
        "scopes_fired": len(scopes),
        "instruments": sorted(set(symbols.values()))[:20],
        "first_fired": fired_dates[0] if fired_dates else None,
        "last_fired": fired_dates[-1] if fired_dates else None,
        "fired_dates": fired_dates[-20:],
        "points_skipped": skipped_points,
        "skip_reasons": [r for r, _ in skip_reasons.most_common(3)],
        "note": "raw evaluations: cooldown_days is not applied; a rule never fires on missing data",
    }


def _backtest_json(bt: dict) -> dict:
    return {
        k: (
            v.isoformat()
            if isinstance(v, dt.date)
            else [x.isoformat() if isinstance(x, dt.date) else x for x in v]
            if isinstance(v, list)
            else v
        )
        for k, v in bt.items()
    }


def _backtest_labelled(bt: dict) -> dict:
    out: dict[str, Any] = {}
    for key, value in bt.items():
        if key in ("from", "to", "first_fired", "last_fired"):
            out[key] = L.date(value)
        elif key == "fired_dates":
            out[key] = [L.date(d) for d in value]
        elif key == "instruments":
            out[key] = [L.symbol(s) for s in value]
        elif key in ("skip_reasons",):
            out[key] = [L.text(r) for r in value]
        elif key == "note":
            out[key] = L.text(value)
        else:
            out[key] = L.count(value)
    return out


def propose_custom_rule(
    ctx: ToolContext,
    kind_or_expression: str,
    params: dict,
    reason: str | None,
    *,
    dry_run: bool = False,
) -> dict:
    yaml_text, md = _current_files(ctx.profile.slug)
    if yaml_text is None:
        raise ToolError(
            "the profile has no strategy yet: propose_strategy first (or the owner runs strategy init)",
            "no_strategy",
        )
    entry, expression = _rule_entry(kind_or_expression, params, _existing_rule_ids(yaml_text))
    _merged, result, own = _validate_rule(yaml_text, md, entry, expression)
    errors = [i for i in own if i["severity"] == "error"]
    out: dict[str, Any] = {
        "rule_id": L.text(entry["id"]),
        "kind": L.category(entry["kind"]),
        "scope": L.category((entry.get("params") or {}).get("scope")),
        "valid": L.flag(not errors and result is not None),
        "issues": [
            {
                "severity": L.category(i["severity"]),
                "path": L.text(i["path"]),
                "message": L.text(i["message"]),
                "line": L.count(i["line"]),
                "column": L.count(i["column"]),
            }
            for i in own
        ],
        "stored": L.flag(False),
        "dry_run": L.flag(dry_run),
    }
    if errors or result is None:
        out["note"] = L.text("not stored: fix the errors and propose again")
        return out
    config = result.config or result.partial
    spec = config.rule(entry["id"]) if config is not None else None
    if spec is None:
        out["valid"] = L.flag(False)
        out["note"] = L.text("not stored: the rule did not load")
        return out
    bt = backtest(ctx, spec, config)
    out["backtest"] = _backtest_labelled(bt)
    if dry_run:
        return out
    row = proposals.create(
        ctx.session,
        ctx.profile,
        "custom_rule",
        {
            "rule": entry,
            "rule_yaml": _render_rule(entry, ""),
            "base_sha256": _digest(yaml_text, md),
            "backtest": _backtest_json(bt),
        },
        summary=f"Rule {entry['id']} ({entry['kind']}): fired {bt.get('episodes', 0)}x in backtest",
        summary_params={
            "rule_id": entry["id"],
            "rule_kind": entry["kind"],
            "episodes": bt.get("episodes", 0),
            "evaluated": bt.get("evaluated", 0),
        },
        reason=reason,
    )
    out["stored"] = L.flag(True)
    out["proposal_id"] = L.ref(row.id)
    out["note"] = L.text("stored as a proposal; the owner approves it in the app (Inwestycje)")
    return out


def _rule_detail(session: Session, profile: Profile, row: Proposal) -> dict:
    p = row.payload or {}
    current_yaml, _md, _err = _read_quiet(profile.slug)
    merged = (
        merge_rule(current_yaml, p["rule"]) if current_yaml is not None and p.get("rule") else None
    )
    return {
        "rule_yaml": p.get("rule_yaml"),
        "backtest": p.get("backtest"),
        "diff": {"yaml": _unified(current_yaml, merged, "strategy.yaml") if merged else None},
    }


def _rule_apply(profile: Profile, row: Proposal) -> dict:
    from finanse.modules.investments.strategy import load_strategy

    p = row.payload or {}
    entry = p.get("rule")
    if not isinstance(entry, dict):
        raise ProposalError("the proposal has no rule", "invalid")
    current_yaml, current_md, err = _read_quiet(profile.slug)
    if err is not None or current_yaml is None:
        raise ProposalError("the strategy file is missing or cannot be read", "strategy_missing")
    if entry.get("id") in _existing_rule_ids(current_yaml):
        raise ProposalError(f"the strategy already has a rule {entry.get('id')}", "rule_exists")
    merged = merge_rule(current_yaml, entry)
    warnings = check_resulting(
        load_strategy(merged, current_md),
        load_strategy(current_yaml, current_md),
        new_rule_id=entry.get("id"),
    )
    return _strategy_change(
        profile,
        (current_yaml, current_md),
        merged,
        None,
        {"rule_id": entry.get("id"), "warnings": warnings},
    )


# --------------------------------------------------------------------------- #
# Imports
# --------------------------------------------------------------------------- #


def _value_free(message: str) -> str:
    """An importer message without the cell values it may quote: quoted text, "(got ...)" parts and
    numbers other than row / line / column numbers are replaced."""
    text = re.sub(r"'[^']*'|\"[^\"]*\"", "'<value>'", message or "")
    text = re.sub(r"\(got [^)]*\)", "(got <value>)", text)
    text = re.sub(r"\bgot (?!<value>)[^\s)]+", "got <value>", text)
    return re.sub(r"(?<!row )(?<!line )(?<!column )(?<!rows )\b\d[\d.,]*\b", "#", text)


def _by_kind(issues) -> list[dict]:
    grouped: dict[str, list] = defaultdict(list)
    for w in issues:
        grouped[str(getattr(w, "kind", "other"))].append(w)
    return [
        {
            "kind": L.category(kind),
            "count": L.count(len(items)),
            "rows": [L.count(w.row) for w in items if getattr(w, "row", None) is not None][:20],
            "example": L.text(_value_free(getattr(items[0], "message", ""))),
        }
        for kind, items in sorted(grouped.items())
    ]


def _mapping_text(raw: str | None, slug: str) -> str | None:
    """Mapping YAML text, or the text of a .yaml / .yml file in the profile's folder (the skills
    write mappings to its extensions folder; other locations are refused so a mapping path cannot
    probe arbitrary files)."""
    if raw is None:
        return None
    candidate = raw.strip()
    if "\n" not in candidate and candidate.lower().endswith((".yaml", ".yml")):
        path = checked_local_file(candidate, slug, ("yaml", "yml"), profile_only=True)
        if path.stat().st_size > MAX_MAPPING_BYTES:
            raise ToolError("the mapping file is too large")
        return path.read_text(encoding="utf-8")
    return raw


def _converter(ctx_session: Session, profile_id: int, slug: str, name: str) -> dict:
    try:
        _path, data, sha = converters.read_script(slug, name)
    except converters.ConverterError as e:
        raise ToolError(str(e), "converter") from None
    clean = converters.clean_name(name)
    return {
        "name": clean,
        "sha256": sha,
        "bytes": data,
        "approved": sha in converters.approved_hashes(ctx_session, profile_id, clean),
    }


def validate_file(
    ctx: ToolContext, path: str, *, mapping: str | None = None, converter: str | None = None
) -> dict:
    from finanse.modules.investments.importing import (
        CsvMapping,
        CsvMappingError,
        GenericCsvImporter,
        ImportFile,
        validate_import,
    )

    p = checked_path(path, ctx.profile.slug)
    content = p.read_bytes()
    name = p.name
    importer = None
    used = "finanse"
    if converter:
        conv = _converter(ctx.session, ctx.profile_id, ctx.profile.slug, converter)
        if not conv["approved"]:
            raise ToolError(
                "converter not approved yet (this exact version): propose_import with it so the owner "
                "can approve it, or run it locally and validate its output file",
                "not_approved",
            )
        try:
            content = converters.run(conv["bytes"], name, content)
        except converters.ConverterError as e:
            raise ToolError(str(e), "converter") from None
        name = "converted.csv"
        used = f"converter {conv['name']}"
    elif mapping:
        try:
            importer = GenericCsvImporter(
                CsvMapping.from_yaml(_mapping_text(mapping, ctx.profile.slug))
            )
        except CsvMappingError as e:
            return {
                "ok": L.flag(False),
                "importer": L.category("generic_csv"),
                "mapping_errors": [
                    {
                        "path": L.text(i.path),
                        "message": L.text(_value_free(i.message)),
                        "line": L.count(i.line),
                    }
                    for i in e.issues
                ],
            }
        used = "generic_csv"
    report = validate_import(ImportFile(name, content), importer)
    return {
        "ok": L.flag(report.ok),
        "importer": L.category(report.importer_id or used),
        "via": L.text(used),
        "transactions": L.count(report.txn_count),
        "positions": L.count(report.position_count),
        "corporate_actions": L.count(report.corporate_action_count),
        "errors": L.count(len(report.errors)),
        "warnings": L.count(len(report.warnings)),
        "errors_by_kind": _by_kind(report.errors),
        "warnings_by_kind": _by_kind(report.warnings),
    }


def _brokerage_account(ctx: ToolContext, account: str) -> int:
    from finanse.modules.investments.store.transactions import brokerage_accounts

    rows = brokerage_accounts(ctx.session, ctx.profile_id)
    text = (account or "").strip()
    labels = ctx.account_labels
    for a in rows:
        if text.isdigit() and int(text) == a.id:
            return a.id
        if labels.get(a.id, "").casefold() == text.casefold():
            return a.id
    raise ToolError(
        "no such brokerage account; use the account label or id from portfolio_overview",
        "not_found",
    )


def _preview_summary(pv) -> dict[str, Any]:
    plan = pv.plan
    recon = pv.reconciliation
    return {
        "importer": pv.importer_id,
        "can_commit": pv.can_commit,
        "rows": len(plan.rows) if plan else 0,
        "new": plan.new_count if plan else 0,
        "duplicates": plan.duplicate_count if plan else 0,
        "positions": len(plan.positions) if plan else 0,
        "renames": len(plan.renames) if plan else 0,
        "status_changes": len(plan.status_changes) if plan else 0,
        "new_instruments": len(plan.new_instruments) if plan else 0,
        "reconciliation_mismatches": len(recon.mismatches) if recon else 0,
        "warnings": len(pv.warnings),
        "errors": len(pv.errors),
    }


def _summary_labelled(summary: dict, pv) -> dict:
    out = {
        k: (
            L.flag(v)
            if isinstance(v, bool)
            else L.count(v)
            if isinstance(v, int)
            else L.category(v)
        )
        for k, v in summary.items()
    }
    out["warnings_by_kind"] = _by_kind(pv.warnings)
    out["errors_by_kind"] = _by_kind(pv.errors)
    return out


def _stage(slug: str, sha: str, file_name: str, content: bytes) -> str:
    from finanse.modules.investments.service import files

    target = files.imports_dir(slug) / ".proposals" / f"{sha}.{files.extension(file_name)}"
    files.write_private(target, content)
    return files.relative_to_data_dir(target)


def _staged_file(relative: str) -> Path:
    from finanse.core import paths

    root = paths.data_dir().resolve()
    path = (root / relative).resolve()
    if not inside(path, root):
        raise ProposalError("the stored file path is invalid", "staged_missing")
    return path


def propose_import(
    ctx: ToolContext,
    path: str,
    account: str,
    *,
    mapping: str | None = None,
    converter: str | None = None,
    importer: str = "auto",
    reason: str | None = None,
) -> dict:
    from finanse.modules.investments.importing import ImportFile
    from finanse.modules.investments.service import imports

    account_id = _brokerage_account(ctx, account)
    p = checked_path(path, ctx.profile.slug)
    content = p.read_bytes()
    sha = hashlib.sha256(content).hexdigest()
    mapping_yaml = _mapping_text(mapping, ctx.profile.slug)
    conv = None
    preview_content, preview_name, preview_importer = content, p.name, importer
    if converter:
        conv = _converter(ctx.session, ctx.profile_id, ctx.profile.slug, converter)
        if conv["approved"]:
            try:
                preview_content = converters.run(conv["bytes"], p.name, content)
            except converters.ConverterError as e:
                raise ToolError(str(e), "converter") from None
            preview_name, preview_importer, mapping_yaml = "converted.csv", "finanse", None
    pv = None
    if conv is None or conv["approved"]:
        try:
            pv = imports.preview(
                ctx.session,
                ctx.profile,
                imports.ImportRequest(
                    ImportFile(preview_name, preview_content),
                    account_id,
                    preview_importer,
                    mapping_yaml,
                ),
            )
        except imports.ImportFailure as e:
            raise ToolError(_value_free(str(e))) from None
        summary = _preview_summary(pv)
        if not pv.can_commit:
            return {
                "stored": L.flag(False),
                "preview": _summary_labelled(summary, pv),
                "note": L.text("not stored: the preview has blocking errors (by kind above)"),
            }
    else:
        summary = None
    staged = _stage(ctx.profile.slug, sha, p.name, content)
    label = ctx.account_labels.get(account_id)
    payload = {
        "account_id": account_id,
        "account_label": label,
        "file_name": p.name,
        "file_sha256": sha,
        "staged": staged,
        "importer": importer,
        "mapping_yaml": None if conv else mapping_yaml,
        "converter": None if conv is None else {"name": conv["name"], "sha256": conv["sha256"]},
        "preview": summary,
    }
    what = f"converter {conv['name']}" if conv else (summary or {}).get("importer") or importer
    row = proposals.create(
        ctx.session,
        ctx.profile,
        "import",
        payload,
        summary=f"Import into {label} ({what})"
        + (f": {summary['new']} new rows" if summary else ": converter awaiting approval"),
        summary_params={
            "account": label,
            "importer": (summary or {}).get("importer"),
            "converter": conv["name"] if conv else None,
            "new": (summary or {}).get("new"),
            "duplicates": (summary or {}).get("duplicates"),
        },
        reason=reason,
    )
    out: dict[str, Any] = {
        "stored": L.flag(True),
        "proposal_id": L.ref(row.id),
        "account": L.account(label),
        "file": L.identifier(p.name),
        "preview": _summary_labelled(summary, pv) if pv is not None else None,
        "converter": None
        if conv is None
        else {"name": L.text(conv["name"]), "approved_before": L.flag(conv["approved"])},
        "note": L.text(
            "stored as a pending import; the owner reviews and commits it in the app"
            + (
                ""
                if conv is None or conv["approved"]
                else " (the converter script runs only after the owner approves it there)"
            )
        ),
    }
    return out


def _import_detail(session: Session, profile: Profile, row: Proposal) -> dict:
    p = row.payload or {}
    out: dict[str, Any] = {
        "account": p.get("account_label"),
        "file_name": p.get("file_name"),
        "preview": p.get("preview"),
    }
    conv = p.get("converter")
    if conv:
        info: dict[str, Any] = {"name": conv.get("name"), "sha256": conv.get("sha256")}
        try:
            _path, data, sha = converters.read_script(profile.slug, conv["name"])
            info["changed"] = sha != conv.get("sha256")
            info["source"] = data.decode("utf-8", errors="replace") if not info["changed"] else None
        except converters.ConverterError as e:
            info["changed"] = True
            info["error"] = str(e)
        info["approved_before"] = conv.get("sha256") in converters.approved_hashes(
            session, profile.id, conv.get("name") or ""
        )
        out["converter"] = info
    return out


def _import_apply(profile: Profile, row: Proposal) -> dict:
    from finanse.modules.investments.importing import ImportFile
    from finanse.modules.investments.service import imports

    p = row.payload or {}
    staged = _staged_file(p.get("staged") or "")
    if not staged.is_file():
        raise ProposalError(
            "the stored export file is gone; propose the import again", "staged_missing"
        )
    content = staged.read_bytes()
    if hashlib.sha256(content).hexdigest() != p.get("file_sha256"):
        raise ProposalError(
            "the stored export file changed; propose the import again", "staged_changed"
        )
    name, importer, mapping_yaml = (
        p.get("file_name") or staged.name,
        p.get("importer") or "auto",
        p.get("mapping_yaml"),
    )
    conv = p.get("converter")
    if conv:
        try:
            _path, data, sha = converters.read_script(profile.slug, conv["name"])
        except converters.ConverterError as e:
            raise ProposalError(str(e), "converter_missing") from None
        if sha != conv.get("sha256"):
            raise ProposalError(
                "the converter script changed since it was proposed; ask for a new proposal",
                "converter_changed",
            )
        try:
            content = converters.run(data, name, content)
        except converters.ConverterError as e:
            raise ProposalError(str(e), "converter_failed") from None
        name, importer, mapping_yaml = "converted.csv", "finanse", None
    with get_session() as s:
        fresh = s.get(Profile, profile.id)
        try:
            pv = imports.preview(
                s,
                fresh,
                imports.ImportRequest(
                    ImportFile(name, content), p["account_id"], importer, mapping_yaml
                ),
            )
        except imports.ImportFailure as e:
            raise ProposalError(str(e), "import_failed") from None
    if not pv.can_commit:
        problems = "; ".join(str(e) for e in pv.errors)[:500]
        raise ProposalError(f"the file cannot be imported now: {problems}", "import_blocked")
    try:
        result = imports.commit(pv)
    except imports.ImportFailure as e:
        raise ProposalError(str(e), "import_failed") from None
    staged.unlink(missing_ok=True)
    return {
        "batch_id": result.batch_id,
        "inserted": result.inserted,
        "duplicates": result.duplicates,
        "positions": result.positions,
        "new_instruments": len(result.new_instrument_ids),
        "converter": conv.get("name") if conv else None,
    }


def _import_discard(row: Proposal) -> None:
    """A rejected import: remove its stored export file (approved ones are archived by the commit)."""
    try:
        _staged_file((row.payload or {}).get("staged") or "").unlink(missing_ok=True)
    except (ProposalError, OSError):
        pass


KINDS = (
    ProposalKind("strategy", _strategy_detail, _strategy_apply),
    ProposalKind("custom_rule", _rule_detail, _rule_apply),
    ProposalKind("import", _import_detail, _import_apply, _import_discard),
)
