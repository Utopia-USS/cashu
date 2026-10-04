"""Profiles: who owns which accounts, and which modules they use.

Every account belongs to exactly one profile; learned category rules and import
batches too. The seed categorization taxonomy is global.

The *default profile* is the one named by ``FINANSE_PROFILE`` (settings or env),
else the oldest profile. It backs the legacy ``/api/*`` aliases and CLI commands
run without ``--profile``. Service functions take ``profile_id=None`` to mean the
default profile: reads then see nothing when no profile exists yet, writes create
the default profile (``default`` / "Domyślny", with the upstream modules enabled)
so an upstream-style ``finanse import-csv`` on a fresh install keeps working.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

from sqlmodel import Session, select

from . import modules
from .models import Account, Profile, ProfileModule, utcnow

DEFAULT_SLUG = "default"
DEFAULT_NAME = "Domyślny"  # Polish UI data
# What an upstream installation used: the default profile created on demand gets these.
UPSTREAM_MODULES = ("budget", "assets", "loans")
PRIVACY_LEVELS = ("strict", "amounts")
NO_PROFILE = 0  # an id no row has: scoped reads before any profile exists return nothing

_SLUG_MAX = 40


class ProfileError(ValueError):
    """Invalid profile data (message is safe to show to the user)."""


class ProfileNotFound(LookupError):
    pass


# --------------------------------------------------------------------------- #
# Slugs
# --------------------------------------------------------------------------- #

def slugify(name: str) -> str:
    """ASCII slug of a display name: ``"Jakub Łoś"`` -> ``"jakub-los"``."""
    text = name.replace("ł", "l").replace("Ł", "L")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:_SLUG_MAX].strip("-") or "profil"


def unique_slug(session: Session, name: str) -> str:
    base = slugify(name)
    taken = {p.slug for p in session.exec(select(Profile)).all()}
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


# --------------------------------------------------------------------------- #
# Lookup and the default profile
# --------------------------------------------------------------------------- #

def list_profiles(session: Session) -> list[Profile]:
    return list(session.exec(select(Profile).order_by(Profile.id)).all())


def get_by_slug(session: Session, slug: str) -> Profile | None:
    return session.exec(select(Profile).where(Profile.slug == slug)).first()


def configured_default_slug() -> str | None:
    from ..config import settings

    return settings.profile or None


def default_profile(session: Session, *, create: bool = False) -> Profile | None:
    """``FINANSE_PROFILE`` if it names an existing profile, else the oldest one;
    with ``create``, a fresh database gets the default profile."""
    slug = configured_default_slug()
    if slug:
        p = get_by_slug(session, slug)
        if p is not None:
            return p
    p = session.exec(select(Profile).order_by(Profile.id)).first()
    if p is not None or not create:
        return p
    return create_profile(
        session, name=DEFAULT_NAME, slug=slug or DEFAULT_SLUG, modules_=UPSTREAM_MODULES
    )


def resolve(session: Session, slug: str | None, *, create_default: bool = False) -> Profile:
    """The profile named ``slug`` or, without a slug, the default profile."""
    if slug:
        p = get_by_slug(session, slug)
        if p is None:
            raise ProfileNotFound(f"No profile '{slug}'")
        return p
    p = default_profile(session, create=create_default)
    if p is None:
        raise ProfileNotFound("No profile yet")
    return p


def scope(session: Session, profile_id: int | None, *, create: bool = False) -> int:
    """The profile id a service call works on: ``profile_id`` or the default
    profile's (created when ``create``); ``NO_PROFILE`` when there is none."""
    if profile_id is not None:
        return profile_id
    p = default_profile(session, create=create)
    return p.id if p is not None and p.id is not None else NO_PROFILE


def account_ids_query(profile_id: int):
    """Subquery of the profile's account ids (for ``Model.account_id.in_(...)``)."""
    return select(Account.id).where(Account.profile_id == profile_id)


# --------------------------------------------------------------------------- #
# Create / update
# --------------------------------------------------------------------------- #

def _clean_currency(value: str) -> str:
    cur = (value or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", cur):
        raise ProfileError("base_currency must be a 3-letter currency code (e.g. PLN)")
    return cur


def _clean_name(value: str) -> str:
    name = (value or "").strip()
    if not name:
        raise ProfileError("name is required")
    if len(name) > 80:
        raise ProfileError("name is too long (max 80 characters)")
    return name


def _clean_privacy(value: str) -> str:
    if value not in PRIVACY_LEVELS:
        raise ProfileError(f"mcp_privacy must be one of: {', '.join(PRIVACY_LEVELS)}")
    return value


def _clean_modules(module_ids: Iterable[str]) -> list[str]:
    ids = list(dict.fromkeys(module_ids))
    known = modules.registry()
    unknown = [m for m in ids if m not in known]
    if unknown:
        raise ProfileError(f"unknown module(s): {', '.join(unknown)}")
    return modules.with_dependencies(ids)


def create_profile(
    session: Session,
    *,
    name: str,
    base_currency: str = "PLN",
    modules_: Iterable[str] = (),
    mcp_privacy: str = "strict",
    slug: str | None = None,
) -> Profile:
    name = _clean_name(name)
    profile = Profile(
        slug=slug or unique_slug(session, name),
        name=name,
        base_currency=_clean_currency(base_currency),
        mcp_privacy=_clean_privacy(mcp_privacy),
    )
    if get_by_slug(session, profile.slug) is not None:
        raise ProfileError(f"profile '{profile.slug}' already exists")
    session.add(profile)
    session.flush()
    set_modules(session, profile, modules_)
    return profile


def update_profile(
    session: Session,
    profile: Profile,
    *,
    name: str | None = None,
    base_currency: str | None = None,
    mcp_privacy: str | None = None,
) -> Profile:
    if name is not None:
        profile.name = _clean_name(name)
    if base_currency is not None:
        profile.base_currency = _clean_currency(base_currency)
    if mcp_privacy is not None:
        profile.mcp_privacy = _clean_privacy(mcp_privacy)
    session.add(profile)
    session.flush()
    return profile


def set_modules(session: Session, profile: Profile, module_ids: Iterable[str]) -> list[str]:
    """Enable exactly ``module_ids`` (plus their dependencies). Disabled modules keep
    their row and all their data; enabling again restores them."""
    wanted = set(_clean_modules(module_ids))
    rows = {
        r.module_id: r
        for r in session.exec(
            select(ProfileModule).where(ProfileModule.profile_id == profile.id)
        ).all()
    }
    for module_id in wanted - set(rows):
        session.add(ProfileModule(profile_id=profile.id, module_id=module_id, enabled=True))
    for module_id, row in rows.items():
        enable = module_id in wanted
        if row.enabled != enable:
            row.enabled = enable
            if enable:
                row.enabled_at = utcnow()
            session.add(row)
    session.flush()
    return [m for m in modules.registry() if m in wanted]


def enabled_modules(session: Session, profile_id: int) -> list[str]:
    rows = session.exec(
        select(ProfileModule).where(
            ProfileModule.profile_id == profile_id, ProfileModule.enabled == True
        )
    ).all()
    enabled = {r.module_id for r in rows}
    return [m for m in modules.registry() if m in enabled]


def module_setup(session: Session, profile_id: int, module_id: str) -> modules.SetupStatus:
    spec = modules.get(module_id)
    if spec.setup_status is None:
        return modules.SetupStatus(steps=())
    return spec.setup_status(session, profile_id)


def as_dict(session: Session, profile: Profile) -> dict:
    """The API shape of a profile (every known module, enabled or not)."""
    enabled = set(enabled_modules(session, profile.id))
    return {
        "slug": profile.slug,
        "name": profile.name,
        "base_currency": profile.base_currency,
        "mcp_privacy": profile.mcp_privacy,
        "modules": [
            {
                "id": spec.id,
                "enabled": spec.id in enabled,
                "setup_state": module_setup(session, profile.id, spec.id).state,
            }
            for spec in modules.all_modules()
        ],
    }
