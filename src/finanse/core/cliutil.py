"""Shared CLI output helpers (one console for every module's commands, so tests
and callers can redirect all output in one place)."""

from __future__ import annotations

from decimal import Decimal

from rich.console import Console

console = Console()
err_console = Console(stderr=True)


def fmt(amount: Decimal | None, currency: str = "PLN") -> str:
    if amount is None:
        return "—"
    q = Decimal(amount).quantize(Decimal("0.01"))
    s = f"{q:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} {currency}"


# --------------------------------------------------------------------------- #
# Active profile (root `--profile` option)
# --------------------------------------------------------------------------- #

_profile_slug: str | None = None


def set_profile(slug: str | None) -> None:
    """Remember the profile chosen with the root ``--profile`` option."""
    global _profile_slug
    _profile_slug = slug or None


def profile(session, *, create: bool = True):
    """The profile a command works on: ``--profile``, else ``FINANSE_PROFILE``, else
    the default profile (created on a fresh database when ``create``).

    A profile named with ``--profile`` must exist, also on a fresh database:
    profiles are created explicitly (``finanse profiles add``), a write never lands
    in another profile. Otherwise the command exits with a message."""
    import typer

    from . import profiles
    from .models import Profile

    slug = _profile_slug or profiles.configured_default_slug()
    if not slug and not create and profiles.default_profile(session) is None:
        # Read-only command on a fresh database: an empty placeholder (nothing created).
        return Profile(id=profiles.NO_PROFILE, slug=profiles.DEFAULT_SLUG, name=profiles.DEFAULT_NAME)
    try:
        if not _profile_slug and slug and not profiles.list_profiles(session) and create:
            # FINANSE_PROFILE on a fresh DB: the default profile is created under that slug.
            return profiles.default_profile(session, create=True)
        return profiles.resolve(session, slug, create_default=create)
    except profiles.ProfileNotFound as e:
        known = ", ".join(p.slug for p in profiles.list_profiles(session)) or "none yet"
        err_console.print(
            f"[red]{e}.[/] Profiles: {known} (see `finanse profiles list`; "
            "create one with `finanse profiles add NAME`)."
        )
        raise typer.Exit(1) from None
