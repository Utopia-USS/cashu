"""FastAPI app serving the dashboard + JSON API over the local finance DB.

The app is the composition layer: core routes (accounts, net worth) and each
module's router are mounted under ``/api``; cross-module views (the overview
summary) live here.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from ..core import networth, security
from ..core.api import breakdown_dict, f
from ..core.api import router as core_router
from ..core.db import get_session, init_db
from ..modules.budget import analytics as budget_analytics
from ..modules.budget.api import router as budget_router
from ..modules.loans.api import router as loans_router

STATIC = Path(__file__).parent / "static"
WEBDIST = Path(__file__).parent / "webdist"  # built React SPA (frontend/ → npm run build)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="finanse", docs_url="/api/docs", lifespan=_lifespan)
# Host allowlist (127.0.0.1/localhost on the serving port) + X-Finanse-Token on
# every /api/* request; no CORS middleware on purpose. See core/security.py.
app.add_middleware(security.LocalOnlyMiddleware)

shell_router = APIRouter()


@shell_router.get("/summary")
def summary() -> dict:
    with get_session() as s:
        totals, _lines = networth.net_worth(s)
        bd = networth.net_worth_breakdown(s)
        cashflow = budget_analytics.monthly_cashflow(s)
        active = budget_analytics.active_recurring(s)
    month = cashflow[-1] if cashflow else None
    # Per currency, never summed across currencies. `monthly_total` stays for the
    # legacy dashboard and is the PLN total only.
    monthly_subs: dict[str, Decimal] = {}
    for c in active:
        monthly_subs[c.currency] = monthly_subs.get(c.currency, Decimal(0)) + c.typical_amount
    return {
        "networth": {cur: f(v) for cur, v in sorted(totals.items())},
        "breakdown": breakdown_dict(bd),
        "month": (
            {
                "label": month.label,
                "income": f(month.income),
                "expense": f(month.expense),
                "net": f(month.net),
            }
            if month
            else None
        ),
        "subscriptions": {
            "count": len(active),
            "monthly_total": f(monthly_subs.get("PLN", Decimal(0))),
            "monthly_totals": {cur: f(v) for cur, v in sorted(monthly_subs.items())},
        },
    }


for _router in (shell_router, core_router, budget_router, loans_router):
    app.include_router(_router, prefix="/api")


@app.get("/")
def index() -> HTMLResponse:
    # Prefer the built React SPA; fall back to the legacy single-file dashboard.
    # The per-launch API token rides along as a <meta> tag (the Host check makes
    # this response readable only by the dashboard's own origin).
    spa = WEBDIST / "index.html"
    page = (spa if spa.exists() else STATIC / "index.html").read_text(encoding="utf-8")
    html = security.inject_token_meta(page, security.get_config().token)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


if (WEBDIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEBDIST / "assets"), name="assets")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
