"""Budget derived-state checks: internal-transfer matching recomputed on the dataset
(``budget.transfers``, scope S08) and the deterministic categorization on top of it
(``budget.categories``, scope S09).

Exception to "a check never writes": both checks reset and re-match the profile's transfer groups (and
``categories`` re-runs ``categorize_all(use_llm=False)``) inside a savepoint they roll back (the runner
rolls back after every check as well), so the dataset copy leaves the check as it came in. The TS port is a full recompute (D-24.1); the stored groups are history
dependent (Python matches only ungrouped rows, Q7), so their difference from the recompute is reported
as counts (``drift``), never compared row by row.
"""

from __future__ import annotations

from . import Check, Ctx


def _groups(ctx: Ctx, rows, group_of) -> list[list[str]]:
    """Natural-key groups ``[outflow legs..., other legs...]``, sorted: a pair is ``[out, in]``."""
    members: dict[str, list] = {}
    for t in rows:
        gid = group_of(t)
        if gid is not None:
            members.setdefault(gid, []).append(t)
    out = []
    for legs in members.values():
        neg = sorted(ctx.ids.key("transactions", t.id) for t in legs if t.amount < 0)
        rest = sorted(ctx.ids.key("transactions", t.id) for t in legs if not t.amount < 0)
        out.append(neg + rest)
    return sorted(out)


def _plan(ctx: Ctx, profile_id: int) -> str:
    """EXPLAIN QUERY PLAN of ``match_internal_transfers``' ungrouped query (index names only, no data):
    its inflow order is the plan's row order (PARITY(Q2) in the TS port)."""
    from cashu.modules.budget.models import Transaction
    from cashu.modules.budget.queries import transactions

    stmt = transactions(profile_id, Transaction.transfer_group_id.is_(None))  # type: ignore[union-attr]
    conn = ctx.session.connection()
    compiled = stmt.compile(dialect=conn.dialect)
    params = compiled.construct_params()
    args = tuple(params[k] for k in compiled.positiontup)
    rows = conn.exec_driver_sql("EXPLAIN QUERY PLAN " + str(compiled), args).all()
    return " | ".join(r[3] for r in rows)


def transfers(ctx: Ctx) -> dict:
    from cashu.modules.budget.ingestion.transfers import (
        match_internal_transfers,
        reset_transfer_matches,
    )
    from cashu.modules.budget.models import Transaction
    from cashu.modules.budget.queries import transactions

    out = {}
    for p in ctx.with_module("budget"):
        rows = ctx.session.exec(transactions(p.id).order_by(Transaction.id)).all()
        stored = _groups(ctx, rows, lambda t: t.transfer_group_id)
        flagged = sum(1 for t in rows if t.is_internal_transfer)
        savepoint = ctx.session.begin_nested()
        try:
            reset_transfer_matches(ctx.session, profile_id=p.id)
            ctx.session.flush()
            n = match_internal_transfers(ctx.session, profile_id=p.id)
            ctx.session.flush()
            recomputed = _groups(ctx, rows, lambda t: t.transfer_group_id)
            plan = _plan(ctx, p.id)
        finally:
            savepoint.rollback()
        same = sum(1 for g in recomputed if g in stored)
        out[ctx.pkey(p)] = {
            "pairs": n,
            "groups": recomputed,
            "drift": {
                "only_stored": len(stored) - same,
                "only_recompute": len(recomputed) - same,
                "same": same,
                "stored_flagged_rows": flagged,
            },
            "plan": plan,
        }
    return out


# Category sources a cash-account row keeps as a claim (D-09.4: other rows there get no category in TS).
_DECIDED = {"manual_txn", "llm_full", "llm_fallback", "cash_leg"}


def categories(ctx: Ctx) -> dict:
    """Per profile: ``categorize_all(use_llm=False)`` after a fresh transfer match, per row in id order;
    the recurring payees it used (``detect_recurring`` on the same state, before the run: decided
    categories are the stored claims, Q6) and the drift of the recompute from the stored values per
    stored ``category_source`` (counts only, D-24.1)."""
    from cashu.modules.budget import analytics, service
    from cashu.modules.budget.cash import cash_account_ids
    from cashu.modules.budget.ingestion.transfers import (
        match_internal_transfers,
        reset_transfer_matches,
    )
    from cashu.modules.budget.models import Transaction
    from cashu.modules.budget.queries import transactions

    out = {}
    for p in ctx.with_module("budget"):
        rows = ctx.session.exec(transactions(p.id).order_by(Transaction.id)).all()
        stored = {t.id: (t.category, t.category_source) for t in rows}
        cash_ids = cash_account_ids(ctx.session, p.id)
        cash_unclaimed = sum(
            1 for t in rows
            if t.account_id in cash_ids and not (t.category and t.category_source in _DECIDED)
        )
        savepoint = ctx.session.begin_nested()
        try:
            reset_transfer_matches(ctx.session, profile_id=p.id)
            ctx.session.flush()
            match_internal_transfers(ctx.session, profile_id=p.id)
            ctx.session.flush()
            recurring = analytics.detect_recurring(ctx.session, profile_id=p.id)
            service.categorize_all(ctx.session, use_llm=False, profile_id=p.id)
            ctx.session.flush()
            result = [(t.id, t.category, t.category_source) for t in rows]
        finally:
            savepoint.rollback()
        drift: dict[str, dict[str, int]] = {}
        for tid, cat, src in result:
            kind = drift.setdefault(stored[tid][1] or "null", {"changed": 0, "same": 0})
            kind["same" if stored[tid] == (cat, src) else "changed"] += 1
        out[ctx.pkey(p)] = {
            "rows": [
                {"txn": ctx.ids.key("transactions", tid), "category": cat, "category_source": src}
                for tid, cat, src in result
            ],
            "subscription_payees": sorted({c.counterparty for c in recurring}),
            "recurring": [
                {
                    "counterparty": c.counterparty,
                    "typical_amount": str(c.typical_amount),
                    "occurrences": c.occurrences,
                    "months_covered": c.months_covered,
                    "median_gap_days": c.median_gap_days,
                    "last_date": c.last_date.isoformat(),
                    "currency": c.currency,
                }
                for c in recurring
            ],
            "drift": drift,
            "cash_unclaimed": cash_unclaimed,
        }
    return out


CHECKS = [Check("budget.transfers", transfers), Check("budget.categories", categories)]
