"""FastAPI app serving the dashboard + JSON API over the local finance DB.

The app is the composition layer. Profile-scoped routes (core accounts and net
worth, the overview summary, the router of every registered module) are mounted
under ``/api/p/{slug}/...`` and again under ``/api/...``, where they act on the
default profile so the legacy static page and existing scripts keep working.
Platform routes (``/api/system``, ``/api/modules``, ``/api/profiles``) are not
profile-scoped.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI
from fastapi import Path as PathParam
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from ..core import modules, networth, security
from ..core.api import CurrentProfile, breakdown_dict, f, platform_router, profile_only_router
from ..core.api import router as core_router
from ..core.db import get_session, init_db
from ..modules.budget import analytics as budget_analytics

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
def summary(profile: CurrentProfile) -> dict:
    pid = profile.id
    with get_session() as s:
        totals, _lines = networth.net_worth(s, profile_id=pid)
        bd = networth.net_worth_breakdown(s, profile_id=pid)
        cashflow = budget_analytics.monthly_cashflow(s, profile_id=pid)
        active = budget_analytics.active_recurring(s, profile_id=pid)
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


def _profile_slug(slug: str = PathParam(description="Profile slug")) -> str:
    """Documents and validates the ``{slug}`` of profile-scoped routes; the profile
    itself is resolved by ``core.api.current_profile``."""
    return slug


PROFILE_PREFIX = "/api/p/{slug}"
_profile_routers = [shell_router, core_router] + [
    spec.router for spec in modules.all_modules() if spec.router is not None
]
app.include_router(platform_router, prefix="/api")
for _router in [profile_only_router, *_profile_routers]:
    app.include_router(_router, prefix=PROFILE_PREFIX, dependencies=[Depends(_profile_slug)])
for _router in _profile_routers:  # legacy aliases: the default profile
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
