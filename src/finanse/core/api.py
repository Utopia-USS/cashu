"""Core API: profile resolution, platform routes (system, modules, profiles),
profile-scoped core routes (accounts, net worth) and JSON helpers shared by the
module routers.

Profile-scoped routers are mounted twice by the app: under ``/api/p/{slug}`` and,
as legacy aliases for the default profile, under ``/api`` (see ``current_profile``).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import select

from .. import __version__
from . import modules, networth, paths, profiles
from .db import get_session
from .models import Account, Profile

# Profile-scoped core routes (mounted under /api/p/{slug} and /api).
router = APIRouter()
# Platform routes, not profile-scoped (mounted under /api).
platform_router = APIRouter()
# Profile-scoped routes without a legacy alias (mounted under /api/p/{slug} only).
profile_only_router = APIRouter()


def f(value: Decimal | None) -> float | None:
    """Decimal -> JSON number (None stays None)."""
    return float(value) if value is not None else None


# --------------------------------------------------------------------------- #
# Profile resolution
# --------------------------------------------------------------------------- #

def current_profile(request: Request) -> Profile:
    """The profile a request works on.

    ``/api/p/{slug}/...``: that profile (404 when unknown). Legacy ``/api/...``
    aliases: the default profile (``FINANSE_PROFILE``, else the oldest). Before any
    profile exists a legacy read sees an empty placeholder (nothing is created, so
    the first-launch wizard still shows) and a legacy write creates the default
    profile, as the upstream app simply wrote to its single database.
    """
    slug = request.path_params.get("slug")
    with get_session() as s:
        if slug is not None:
            profile = profiles.get_by_slug(s, slug)
            if profile is None:
                raise HTTPException(status_code=404, detail=f"No profile '{slug}'")
            return profile
        write = request.method not in ("GET", "HEAD", "OPTIONS")
        profile = profiles.default_profile(s, create=write)
        if profile is not None:
            return profile
    return Profile(id=profiles.NO_PROFILE, slug=profiles.DEFAULT_SLUG, name=profiles.DEFAULT_NAME)


# Endpoint parameter type: `profile: CurrentProfile`.
CurrentProfile = Annotated[Profile, Depends(current_profile)]


def _profile_or_404(session, slug: str) -> Profile:
    profile = profiles.get_by_slug(session, slug)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"No profile '{slug}'")
    return profile


# --------------------------------------------------------------------------- #
# Platform: system, modules, profiles
# --------------------------------------------------------------------------- #

@platform_router.get("/system")
def system() -> dict:
    legacy = paths.legacy_db_path()
    detected = legacy.exists() and not paths.migration_marker_path().exists()
    return {
        "version": __version__,
        "data_dir": str(paths.data_dir()),
        "legacy_db_detected": detected,
        "legacy_db_path": str(legacy) if detected else None,
        "worker": {"installed": False, "last_run": None},  # background worker: F3
    }


@platform_router.get("/modules")
def list_modules() -> list[dict]:
    """Every module the app knows (core is implicit), in display order."""
    return [
        {
            "id": spec.id,
            "name": spec.name,
            "description": spec.description,
            "depends_on": list(spec.depends_on),
            "available": spec.available,
        }
        for spec in modules.all_modules()
    ]


class ProfileCreate(BaseModel):
    name: str
    base_currency: str = "PLN"
    modules: list[str] = []
    mcp_privacy: str = "strict"


class ProfilePatch(BaseModel):
    name: str | None = None
    base_currency: str | None = None
    mcp_privacy: str | None = None


class ProfileModules(BaseModel):
    modules: list[str]


@platform_router.get("/profiles")
def list_profiles() -> list[dict]:
    with get_session() as s:
        return [profiles.as_dict(s, p) for p in profiles.list_profiles(s)]


@platform_router.post("/profiles", status_code=201)
def create_profile(body: ProfileCreate) -> dict:
    with get_session() as s:
        try:
            p = profiles.create_profile(
                s,
                name=body.name,
                base_currency=body.base_currency,
                modules_=body.modules,
                mcp_privacy=body.mcp_privacy,
            )
        except profiles.ProfileError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
        return profiles.as_dict(s, p)


@platform_router.get("/profiles/{slug}")
def get_profile(slug: str) -> dict:
    with get_session() as s:
        return profiles.as_dict(s, _profile_or_404(s, slug))


@platform_router.patch("/profiles/{slug}")
def patch_profile(slug: str, body: ProfilePatch) -> dict:
    with get_session() as s:
        p = _profile_or_404(s, slug)
        try:
            profiles.update_profile(
                s, p, name=body.name, base_currency=body.base_currency,
                mcp_privacy=body.mcp_privacy,
            )
        except profiles.ProfileError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
        return profiles.as_dict(s, p)


@platform_router.put("/profiles/{slug}/modules")
def put_profile_modules(slug: str, body: ProfileModules) -> dict:
    """Enable exactly these modules (plus dependencies); disabling keeps the data."""
    with get_session() as s:
        p = _profile_or_404(s, slug)
        try:
            profiles.set_modules(s, p, body.modules)
        except profiles.ProfileError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
        return profiles.as_dict(s, p)


@profile_only_router.get("/modules/{module_id}/setup")
def module_setup(profile: CurrentProfile, module_id: str) -> dict:
    """The module's blank-page status for the profile (steps + Claude Code skill)."""
    try:
        spec = modules.get(module_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown module '{module_id}'") from None
    with get_session() as s:
        status = profiles.module_setup(s, profile.id, module_id)
    skill = None
    if spec.skill:
        skill = {
            "command": spec.skill,
            "mcp_add": f"claude mcp add finanse-{profile.slug} -- finanse mcp --profile {profile.slug}",
        }
    return {"state": status.state, "steps": status.step_dicts(), "skill": skill}


# --------------------------------------------------------------------------- #
# Profile-scoped core routes
# --------------------------------------------------------------------------- #

def account_row(acc: Account, contribution: Decimal | None, as_of) -> dict:
    return {
        "id": acc.id,
        "bank": acc.bank.value,
        "name": acc.name,
        "type": acc.type.value,
        "currency": acc.currency,
        "iban_tail": (acc.iban or "")[-4:],
        "balance": f(contribution),
        "as_of": as_of.isoformat() if as_of else None,
        "is_liability": acc.type.value == "credit",
    }


def breakdown_dict(bd) -> dict:
    return {
        "currency": bd.currency,
        "assets": f(bd.assets),
        "liabilities": f(bd.liabilities),
        "net": f(bd.net),
        "property": f(bd.property_value),
        "mortgage": f(bd.mortgage),
        "home_equity": f(bd.home_equity),
        "by_type": {k: f(v) for k, v in bd.by_type.items()},
    }


@router.get("/networth")
def networth_ep(profile: CurrentProfile) -> dict:
    with get_session() as s:
        totals, lines = networth.net_worth(s, profile_id=profile.id)
        bd = networth.net_worth_breakdown(s, profile_id=profile.id)
        accounts = [account_row(ln.account, ln.contribution, ln.as_of) for ln in lines]
    return {
        "totals": {cur: f(v) for cur, v in sorted(totals.items())},
        "breakdown": breakdown_dict(bd),
        "accounts": accounts,
    }


@router.get("/networth/series")
def networth_series(
    profile: CurrentProfile,
    currency: str = "PLN",
    granularity: str = "daily",
    scope: str = "total",
) -> dict:
    with get_session() as s:
        series = networth.net_worth_component_series(
            s, currency=currency, granularity=granularity, scope=scope, profile_id=profile.id
        )
    present = [k for k in networth.component_order() if any(k in comps for _, comps in series)]
    labels = networth.component_labels()
    liabilities = networth.liability_components()
    points = [
        {
            "date": d.isoformat(),
            "value": f(sum(comps.values(), Decimal(0))),
            "components": {k: f(comps[k]) for k in present if k in comps},
        }
        for d, comps in series
    ]
    return {
        "points": points,
        "components": [
            {"key": k, "label": labels[k], "liability": k in liabilities}
            for k in present
        ],
    }


@router.get("/accounts")
def accounts(profile: CurrentProfile) -> list[dict]:
    with get_session() as s:
        rows = s.exec(select(Account).where(Account.profile_id == profile.id)).all()
        return [account_row(a, None, None) | {"active": a.active} for a in rows]
