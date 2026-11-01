"""Budget derived-state checks (scope S08): internal-transfer matching recomputed on the dataset
(``budget.transfers``). S09 adds ``budget.categories`` to this file.

Exception to "a check never writes": ``transfers`` resets and re-matches the profile's transfer groups
inside a savepoint it rolls back (the runner rolls back after every check as well), so the dataset copy
leaves the check as it came in. The TS port is a full recompute (D-24.1); the stored groups are history
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


CHECKS = [Check("budget.transfers", transfers)]
