"""Performance API (included into the investments router, so mounted under ``/api/p/{slug}`` and the
legacy ``/api`` aliases like every investments route): ``/investments/performance`` and
``/investments/performance/attribution``. Reads only the profile in the URL; ``accounts=1,2`` must name
that profile's brokerage accounts (404 otherwise). Computed from stored data, never from the network
(``cashu invest backfill`` fills the price history). Shapes: the CONTRACT in
``stock/docs/fork/progress/F5-PF.md``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from cashu.core.api import CurrentProfile
from cashu.core.db import get_session

from .performance import service
from .service import views

router = APIRouter(prefix="/performance")


def _accounts(session, profile, raw: str | None) -> list[int] | None:
    try:
        return views.account_filter(session, profile, raw)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


def _range(value: str) -> str:
    try:
        return service.check_range(value)
    except service.RangeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.get("")
def performance(
    profile: CurrentProfile,
    range_key: str = Query("1y", alias="range"),
    accounts: str | None = None,
) -> dict:
    """Value series, contributions, TWR / XIRR, benchmark and its same-cash-flow simulation,
    drawdowns, rolling relative performance and per-account series for ``range`` (1m, 3m, ytd, 1y,
    3y, max)."""
    key = _range(range_key)
    with get_session() as s:
        return service.performance_view(
            s, profile, range_key=key, account_ids=_accounts(s, profile, accounts)
        )


@router.get("/attribution")
def attribution(
    profile: CurrentProfile,
    range_key: str = Query("max", alias="range"),
    accounts: str | None = None,
) -> dict:
    """P/L by instrument and bucket over ``range`` (default the whole history), account-level items
    and profit concentration (top-N share, result without the top 2 vs the benchmark)."""
    key = _range(range_key)
    with get_session() as s:
        return service.attribution_view(
            s, profile, range_key=key, account_ids=_accounts(s, profile, accounts)
        )
