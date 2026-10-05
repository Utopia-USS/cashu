"""Per-profile budget settings: the cushion (emergency fund) top-up rule of the month close.

Stored as ``<data dir>/profiles/<slug>/budget.json`` (owner-only file, next to the strategy files),
so no table is needed. A missing or unreadable file means the defaults (cushion off).

Cushion rule: keep ``target`` money in the cushion accounts; while their balance is below the target,
the month close sets aside ``min(missing, surplus, monthly_max)`` of the surplus in the cushion
currency before suggesting a transfer to investments. The target is a fixed amount
(``target_amount``) or a number of months of average spending (``target_months``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path

from finanse.core import paths

SETTINGS_FILE = "budget.json"
MAX_TARGET_MONTHS = 36
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")


class SettingsError(ValueError):
    """Invalid settings; the message is English and names the field."""


@dataclass(frozen=True)
class CushionSettings:
    enabled: bool = False
    currency: str | None = None
    """Currency the cushion is kept in; None = the profile's base currency."""
    target_amount: Decimal | None = None
    target_months: int | None = None
    """Months of average spending (used when ``target_amount`` is not set)."""
    account_ids: tuple[int, ...] = ()
    """Accounts holding the cushion; empty = the profile's savings accounts in the currency."""
    monthly_max: Decimal | None = None
    """Upper limit of one month's top-up; None = no limit."""


@dataclass(frozen=True)
class BudgetSettings:
    cushion: CushionSettings = field(default_factory=CushionSettings)


def settings_path(slug: str) -> Path:
    if not _SLUG.match(slug or ""):
        raise SettingsError(f"invalid profile slug {slug!r}")
    return paths.data_dir() / "profiles" / slug / SETTINGS_FILE


def load(slug: str) -> BudgetSettings:
    """The profile's settings; the defaults when the file is missing or unreadable."""
    try:
        raw = json.loads(settings_path(slug).read_text(encoding="utf-8"))
        return parse(raw)
    except (OSError, ValueError):
        return BudgetSettings()


def save(slug: str, settings: BudgetSettings) -> Path:
    """Write the settings owner-only (0600), atomically."""
    path = settings_path(slug)
    paths.ensure_private_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(to_dict(settings), fh, indent=2, sort_keys=True)
    os.replace(tmp, path)
    return path


def to_dict(settings: BudgetSettings) -> dict:
    c = asdict(settings.cushion)
    c["target_amount"] = _num(settings.cushion.target_amount)
    c["monthly_max"] = _num(settings.cushion.monthly_max)
    c["account_ids"] = list(settings.cushion.account_ids)
    return {"cushion": c}


def parse(raw: object) -> BudgetSettings:
    """Validate a settings payload (the API body or the stored file). Unknown keys are ignored."""
    if raw is None:
        return BudgetSettings()
    if not isinstance(raw, dict):
        raise SettingsError("settings must be an object")
    cushion = raw.get("cushion")
    if cushion is None:
        return BudgetSettings()
    if not isinstance(cushion, dict):
        raise SettingsError("cushion must be an object")
    enabled = cushion.get("enabled", False)
    if not isinstance(enabled, bool):
        raise SettingsError("cushion.enabled must be true or false")
    currency = cushion.get("currency")
    if currency in ("", None):
        currency = None
    elif not isinstance(currency, str) or not _CURRENCY.match(currency.strip().upper()):
        raise SettingsError("cushion.currency must be a three-letter currency code")
    else:
        currency = currency.strip().upper()
    target_amount = _positive(cushion.get("target_amount"), "cushion.target_amount")
    monthly_max = _positive(cushion.get("monthly_max"), "cushion.monthly_max")
    months = cushion.get("target_months")
    if months in ("", None):
        months = None
    elif (
        isinstance(months, bool)
        or not isinstance(months, int | float)
        or months != int(months)
        or not 1 <= months <= MAX_TARGET_MONTHS
    ):
        raise SettingsError(
            f"cushion.target_months must be a whole number from 1 to {MAX_TARGET_MONTHS}"
        )
    else:
        months = int(months)
    ids = cushion.get("account_ids") or []
    if not isinstance(ids, list) or not all(
        isinstance(i, int) and not isinstance(i, bool) and i > 0 for i in ids
    ):
        raise SettingsError("cushion.account_ids must be a list of account ids")
    if enabled and target_amount is None and months is None:
        raise SettingsError("an enabled cushion needs target_amount or target_months")
    return BudgetSettings(
        CushionSettings(
            enabled=enabled,
            currency=currency,
            target_amount=target_amount,
            target_months=months,
            account_ids=tuple(dict.fromkeys(ids)),
            monthly_max=monthly_max,
        )
    )


def _positive(value: object, name: str) -> Decimal | None:
    if value in ("", None):
        return None
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise SettingsError(f"{name} must be a positive number")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise SettingsError(f"{name} must be a positive number") from None
    if not number.is_finite() or number <= 0:
        raise SettingsError(f"{name} must be a positive number")
    return number.quantize(Decimal("0.01"))


def _num(value: Decimal | None) -> float | None:
    return None if value is None else float(value)
