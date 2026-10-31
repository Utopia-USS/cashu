"""Investments checks: the workspace views (``service/views.py``), the pure valuation / allocation
core (``portfolio/valuation.py``, ``portfolio/allocation.py``), performance (``performance/service.py``),
the rules engine at the fixed ``as_of``, the strategy loader (``strategy/loader.py``) and a dry-run
re-import of every archived import file (``importing/plan.py``)."""

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
    """The pure ``allocate`` result (TS: S13 portfolio math)."""
    out = {}
    for p in ctx.with_module(MODULE):
        _st, state = _state(ctx, p)
        out[ctx.pkey(p)] = {"allocation": state.allocation}
    return out


def allocation_view(ctx: Ctx) -> dict:
    """The allocation view (TS: needs the allocation_drift rule, S15b, and the views, S22a)."""
    from cashu.modules.investments.service import views

    out = {}
    for p in ctx.with_module(MODULE):
        st, state = _state(ctx, p)
        out[ctx.pkey(p)] = {"view": views.allocation_view(state, st.config)}
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


def _plan_id(value):
    """A plan's instrument id: stored ones are ``str(pk)`` (an int here, so canon writes the natural
    key), planned ones stay their ``new-<sha12>-<n>`` text."""
    if value is None:
        return None
    return int(value) if value.isdigit() else value


def _warning(w) -> dict:
    return {"message": w.message, "row": w.row, "blocking": w.blocking, "kind": w.kind}


def _txn(t) -> dict:
    return {
        "type": t.type,
        "trade_date": t.trade_date,
        "currency": t.currency,
        "gross_amount": t.gross_amount,
        "cash_amount": t.cash_amount,
        "cash_currency": t.cash_currency,
        "instrument_id": _plan_id(t.instrument_id),
        "settle_date": t.settle_date,
        "quantity": t.quantity,
        "price": t.price,
        "fee": t.fee,
        "tax": t.tax,
        "fx_rate": t.fx_rate,
        "split_ratio": t.split_ratio,
        "note": t.note,
        "source": t.source,
        "external_ref": t.external_ref,
        "dedup_hash": t.dedup_hash,
        "created_at": t.created_at,
    }


def _instrument(i) -> dict:
    return {
        "id": _plan_id(i.id),
        "name": i.name,
        "currency": i.currency,
        "asset_class": i.asset_class,
        "symbol": i.symbol,
        "isin": i.isin,
        "mic": i.mic,
        "needs_classification": i.needs_classification,
        "valuation_mode": i.valuation_mode,
        "status": i.status,
        "aliases": [
            {"namespace": a.namespace, "value": a.value, "guessed": a.guessed} for a in i.aliases
        ],
    }


def _batch_importer(ctx: Ctx, batch):
    """The importer that parsed the archived file (``imports._choose_importer`` from what the batch
    and the account remember), or the reason it cannot be rebuilt."""
    from cashu.modules.investments.importing import (
        CanonicalImporter,
        CsvMapping,
        GenericCsvImporter,
    )
    from cashu.modules.investments.importing.canonical import canonical_importer_id
    from cashu.modules.investments.service import imports
    from cashu.modules.investments.store import transactions

    if canonical_importer_id(batch.importer) == "cashu":
        return CanonicalImporter(), None
    if imports.is_connector_choice(batch.importer):
        return imports.ConnectorDocumentImporter(batch.importer, batch.importer), None
    settings = transactions.account_settings(ctx.session, batch.account_id)
    if not settings.mapping_yaml:
        return None, "no_mapping"
    mapping = CsvMapping.from_yaml(settings.mapping_yaml)
    if mapping.broker_id != batch.importer:
        return None, "mapping_of_another_importer"
    return GenericCsvImporter(mapping), None


def _replan(ctx: Ctx, batch) -> dict:
    """``plan_import`` of one archived file against the stored instruments and hashes (the preview
    of re-importing it), plus whether its hashes are exactly the stored ones."""
    from itertools import count

    from sqlmodel import select

    from cashu.core import paths
    from cashu.modules.investments.importing import ImportFile, effective_broker_id, plan_import
    from cashu.modules.investments.models import InvTransaction
    from cashu.modules.investments.service import files
    from cashu.modules.investments.store import convert, instruments, transactions

    path = paths.data_dir() / (batch.archive_path or "")
    if not batch.archive_path or not path.is_file():
        return {"archive": "missing"}
    content = path.read_bytes()
    importer, problem = _batch_importer(ctx, batch)
    if importer is None:
        return {"archive": "ok", "importer": problem}
    parsed = importer.parse(ImportFile(batch.file_name, content))
    sha = files.sha256(content)
    planned, txn_ids = count(1), count(1)
    plan = plan_import(
        parsed,
        account_id=convert.sid(batch.account_id),
        broker_id=effective_broker_id(importer, parsed),
        lookup=instruments.DbInstrumentLookup(ctx.session),
        existing_hashes=lambda hashes: transactions.existing_hashes(
            ctx.session, batch.account_id, hashes
        ),
        instrument_id_factory=lambda: f"new-{sha[:12]}-{next(planned)}",
        txn_id_factory=lambda: f"t-{next(txn_ids)}",
    )
    sources = ctx.session.exec(
        select(InvTransaction.dedup_hash, InvTransaction.source).where(
            InvTransaction.import_batch_id == batch.id
        )
    ).all()
    # the batch's own rows; reconciliation corrections applied with the commit are not file rows
    stored = {digest for digest, source in sources if source == "import"}
    hashes = {row.txn.dedup_hash for row in plan.rows}
    return {
        "archive": "ok",
        "sha256_matches": sha == batch.file_sha256,
        "importer": batch.importer,
        "broker_id": plan.broker_id,
        "broker_matches": plan.broker_id == batch.broker,
        "account_hint": plan.account_hint,
        "rows": [
            {
                "row_index": r.parsed.row_index,
                "match": r.match,
                "is_duplicate": r.is_duplicate,
                "txn": _txn(r.txn),
            }
            for r in plan.rows
        ],
        "positions": [
            {
                "parsed_index": p.parsed_index,
                "match": p.match,
                "instrument_id": _plan_id(p.position.instrument_id),
                "quantity": p.position.quantity,
                "currency": p.position.currency,
                "as_of": p.position.as_of,
                "avg_price": p.position.avg_price,
                "market_value": p.position.market_value,
            }
            for p in plan.positions
        ],
        "renames": [
            {
                "date": r.rename.date,
                "old_instrument_id": _plan_id(r.rename.old_instrument_id),
                "new_instrument_id": _plan_id(r.rename.new_instrument_id),
                "note": r.rename.note,
            }
            for r in plan.renames
        ],
        "status_changes": [
            {"instrument_id": _plan_id(c.instrument_id), "status": c.status, "date": c.parsed.date}
            for c in plan.status_changes
        ],
        "new_instruments": [_instrument(i) for i in plan.new_instruments],
        "new_aliases": [
            {
                "instrument_id": _plan_id(instrument_id),
                "aliases": [
                    {"namespace": a.namespace, "value": a.value, "guessed": a.guessed}
                    for a in aliases
                ],
            }
            for instrument_id, aliases in plan.new_aliases.items()
        ],
        "warnings": [_warning(w) for w in plan.warnings],
        "blocking_errors": [_warning(w) for w in plan.blocking_errors],
        "dedup": {
            "rows": len(plan.rows),
            "distinct_hashes": len(hashes),
            "stored_for_batch": len(stored),
            "corrections_for_batch": sum(1 for _d, source in sources if source != "import"),
            "all_rows_stored": all(r.is_duplicate for r in plan.rows),
            "batch_hashes_in_plan": stored <= hashes,
        },
    }


def import_plan(ctx: Ctx) -> dict:
    """Dry-run re-import of every archived file (TS scope S17c): the plan and its dedup hashes."""
    from sqlmodel import select

    from cashu.modules.investments.models import InvImportBatch

    out = {}
    for p in ctx.with_module(MODULE):
        batches = ctx.session.exec(
            select(InvImportBatch)
            .where(InvImportBatch.profile_id == p.id)
            .order_by(InvImportBatch.id)
        ).all()
        out[ctx.pkey(p)] = {ctx.ids.key("inv_import_batches", b.id): _replan(ctx, b) for b in batches}
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
    Check("investments.allocation_view", allocation_view),
    Check("investments.performance", performance),
    Check("investments.rules", rules),
    Check("investments.strategy_loader", strategy_loader),
    Check("investments.import_plan", import_plan),
]
