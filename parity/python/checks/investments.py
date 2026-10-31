"""Investments checks: the workspace views (``service/views.py``), the pure valuation / allocation
core (``portfolio/valuation.py``, ``portfolio/allocation.py``), performance (``performance/service.py``),
the rules engine at the fixed ``as_of`` and the strategy loader (``strategy/loader.py``)."""

from __future__ import annotations

from pathlib import Path

from . import Check, Ctx

MODULE = "investments"


def _state(ctx: Ctx, p):
    """(strategy state, portfolio state) of a profile as of the frozen day, cached per run."""
    from cashu.modules.investments.service import portfolio
    from cashu.modules.investments.service import strategy as strategy_files

    key = ("portfolio", p.id)
    if key not in ctx.cache:
        st = strategy_files.load(ctx.session, p)
        ctx.cache[key] = (st, portfolio.build(ctx.session, p, as_of=ctx.as_of, strategy=st.config))
    return ctx.cache[key]


def overview(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    return {ctx.pkey(p): views.overview(ctx.session, p) for p in ctx.with_module(MODULE)}


def positions(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    return {ctx.pkey(p): views.positions(ctx.session, p) for p in ctx.with_module(MODULE)}


def _held_ids(ctx: Ctx, p) -> list[int]:
    from cashu.modules.investments.service import views

    rows = views.positions(ctx.session, p).get("positions", [])
    return sorted(
        {int(r["instrument"]["id"]) for r in rows if isinstance(r["instrument"]["id"], int)}
    )


def position_detail(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    out = {}
    for p in ctx.with_module(MODULE):
        per = {}
        for iid in _held_ids(ctx, p):
            per[ctx.ids.key("inv_instruments", iid)] = {
                "detail": views.position_detail(ctx.session, p, iid),
                "chart_24m": views.position_chart(ctx.session, p, iid, months=24),
            }
        out[ctx.pkey(p)] = per
    return out


def signals(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    return {
        ctx.pkey(p): {
            st: views.signals_view(ctx.session, p, st) for st in ("open", "history", "all")
        }
        for p in ctx.with_module(MODULE)
    }


def alerts(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    out = {
        ctx.pkey(p): {"alerts": views.alerts_view(ctx.session, p)} for p in ctx.with_module(MODULE)
    }
    out["alert_kinds"] = {"kinds": views.alert_kinds()}
    return out


def watchlist(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    return {
        ctx.pkey(p): views.watchlist_view(ctx.session, p, as_of=ctx.as_of)
        for p in ctx.with_module(MODULE)
    }


def strategy_status(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    return {ctx.pkey(p): views.strategy_status(ctx.session, p) for p in ctx.with_module(MODULE)}


def accounts(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    out = {}
    for p in ctx.with_module(MODULE):
        _st, state = _state(ctx, p)
        out[ctx.pkey(p)] = views.accounts_view(ctx.session, p, state)
    return out


def review_digest(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    out = {}
    for p in ctx.with_module(MODULE):
        out[ctx.pkey(p)] = {
            "digest": views.review_digest(ctx.session, p),
            "last_review": views.last_review(ctx.session, p),
        }
    return out


def valuation(ctx: Ctx) -> dict:
    out = {}
    for p in ctx.with_module(MODULE):
        _st, state = _state(ctx, p)
        out[ctx.pkey(p)] = {
            "as_of": state.as_of,
            "base": state.base,
            "snapshot": state.snapshot,
            "valued": state.valued,
        }
    return out


def allocation(ctx: Ctx) -> dict:
    from cashu.modules.investments.service import views

    out = {}
    for p in ctx.with_module(MODULE):
        st, state = _state(ctx, p)
        out[ctx.pkey(p)] = {
            "allocation": state.allocation,
            "view": views.allocation_view(state, st.config),
        }
    return out


def performance(ctx: Ctx) -> dict:
    from cashu.modules.investments.performance import report
    from cashu.modules.investments.performance import service as perf

    out = {}
    for p in ctx.with_module(MODULE):
        perf.clear_cache()
        out[ctx.pkey(p)] = {
            "performance": {
                r: perf.performance_view(ctx.session, p, range_key=r, as_of=ctx.as_of)
                for r in report.RANGES
            },
            "attribution_max": perf.attribution_view(
                ctx.session, p, range_key="max", as_of=ctx.as_of
            ),
        }
    return out


def rules(ctx: Ctx) -> dict:
    from cashu.modules.investments.rules import RuleContext, RulesEngine
    from cashu.modules.investments.store import convert

    out = {}
    for p in ctx.with_module(MODULE):
        st, state = _state(ctx, p)
        config = st.config
        if config is None:
            out[ctx.pkey(p)] = {"strategy_state": st.state, "outcomes": None}
            continue
        rctx = RuleContext.build(
            profile_id=convert.sid(p.id),
            as_of=ctx.as_of,
            portfolio=state.valued,
            market=state.market,
            allocation=state.allocation,
            data=config.data,
            contributions=config.contributions,
        )
        outcomes = RulesEngine(config.rules).evaluate(rctx)
        out[ctx.pkey(p)] = {
            "strategy_state": st.state,
            "rules": [{"id": r.id, "kind": r.kind} for r in config.rules],
            "outcomes": [{"type": type(o).__name__, "outcome": o} for o in outcomes],
        }
    return out


def strategy_loader(ctx: Ctx) -> dict:
    from cashu.modules.investments import templates
    from cashu.modules.investments.service import strategy as strategy_files
    from cashu.modules.investments.strategy.loader import load_strategy

    out = {}
    for p in ctx.with_module(MODULE):
        st = strategy_files.load(ctx.session, p)
        out[ctx.pkey(p)] = {
            "state": st.state,
            "sha256": st.sha256,
            "changed": st.changed,
            "read_error": st.read_error,
            "version": None if st.version is None else st.version.version,
            "result": st.result,
        }
    folder = Path(templates.__file__).parent / "strategy"
    tpl = {}
    for yaml_file in sorted(folder.glob("*.yaml")):
        md_file = yaml_file.with_suffix(".md")
        md = md_file.read_text(encoding="utf-8") if md_file.is_file() else None
        tpl[yaml_file.stem] = load_strategy(yaml_file.read_text(encoding="utf-8"), md)
    out["templates"] = tpl
    return out


CHECKS = [
    Check("investments.overview", overview),
    Check("investments.positions", positions),
    Check("investments.position_detail", position_detail),
    Check("investments.signals", signals, {"id": "inv_signals"}),
    Check("investments.alerts", alerts),
    Check("investments.watchlist", watchlist, {"id": "watchlist_items"}),
    Check("investments.strategy_status", strategy_status),
    Check("investments.accounts", accounts, {"id": "accounts"}),
    Check("investments.review_digest", review_digest, {"id": "inv_signals"}),
    Check("investments.valuation", valuation),
    Check("investments.allocation", allocation),
    Check("investments.performance", performance),
    Check("investments.rules", rules),
    Check("investments.strategy_loader", strategy_loader),
]
