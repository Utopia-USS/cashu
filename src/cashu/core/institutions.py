"""Institution registry: banks, brokers and exchanges an account can belong to.

``accounts.bank`` stores an institution id from this registry (the upstream
``Bank`` enum values ``mbank``, ``erste``, ``pekao``, ``manual`` stay valid ids).
An entry says how to recognise and read that institution's data:

- ``kind``: ``bank`` | ``broker`` | ``exchange`` | ``manual``;
- ``name``: display name; ``name_en`` its English variant when it differs (``display_name``
  picks the current UI language);
- ``csv_importer``: ``"package.module:ClassName"`` of its statement parser (imported
  lazily, so core never imports a module's code); None = no CSV import yet;
- ``aspsp_patterns``: lowercase substrings of the Enable Banking ASPSP name that
  map an Open Banking session to this institution.

Adding a bank = one ``Institution`` entry here (or registered by a module) + its
parser config in ``modules/budget/ingestion/csv_import/`` (see docs/agents/extending.md).
"""

from __future__ import annotations

import importlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

from .i18n import tr

Kind = Literal["bank", "broker", "exchange", "manual"]

MANUAL = "manual"  # manually tracked positions, the cash pool, loans without a bank feed

_CSV = "cashu.modules.budget.ingestion.csv_import"


@dataclass(frozen=True)
class Institution:
    id: str
    kind: Kind
    name: str
    csv_importer: str | None = None
    aspsp_patterns: tuple[str, ...] = ()
    country: str = "PL"
    name_en: str | None = None


BUILTIN: tuple[Institution, ...] = (
    Institution("mbank", "bank", "mBank", f"{_CSV}.mbank:MBankImporter", ("mbank",)),
    # Erste Bank Polska = the former Santander Bank Polska (legacy exports too).
    Institution(
        "erste", "bank", "Erste Bank Polska", f"{_CSV}.erste:ErsteImporter", ("erste", "santander")
    ),
    Institution("pekao", "bank", "Bank Pekao", f"{_CSV}.pekao:PekaoImporter", ("pekao",)),
    # Open Banking only until the CSV parser lands (needs a sample export).
    Institution("millennium", "bank", "Bank Millennium", None, ("millennium",)),
    # Open Banking only (no CSV parser).
    Institution("revolut", "bank", "Revolut", None, ("revolut",)),
    Institution(MANUAL, "manual", "Ręcznie", name_en="Manual"),
)

_REGISTRY: dict[str, Institution] = {}
_IMPORTERS: dict[str, Any] = {}


class UnknownInstitution(KeyError):
    pass


def register(inst: Institution) -> None:
    current = _REGISTRY.get(inst.id)
    if current is not None and current != inst:
        raise ValueError(f"Institution {inst.id!r} is already registered")
    _REGISTRY[inst.id] = inst


def _ensure_loaded() -> None:
    # Modules may register their own institutions (brokers) through their spec.
    from . import modules

    modules.registry()


def get(institution_id: str) -> Institution:
    _ensure_loaded()
    try:
        return _REGISTRY[institution_id]
    except KeyError:
        raise UnknownInstitution(f"Unknown institution {institution_id!r}") from None


def display_name(institution_id: str) -> str:
    """Display name in the current UI language; for an id no entry knows (an Open Banking bank
    without an entry, an imported institution id) its words, capitalized: "ing-bank-slaski" ->
    "Ing Bank Slaski". Never raises."""
    _ensure_loaded()
    inst = _REGISTRY.get(institution_id)
    if inst is not None:
        return tr(pl=inst.name, en=inst.name_en or inst.name)
    words = [w for w in re.split(r"[-_\s]+", institution_id or "") if w]
    return " ".join(w[:1].upper() + w[1:] for w in words) or (institution_id or "")


def all_institutions(kind: Kind | None = None) -> list[Institution]:
    _ensure_loaded()
    return [i for i in _REGISTRY.values() if kind is None or i.kind == kind]


def ids(kind: Kind | None = None) -> list[str]:
    return [i.id for i in all_institutions(kind)]


def csv_ids() -> list[str]:
    """Ids of institutions whose statements can be imported from CSV."""
    return [i.id for i in all_institutions() if i.csv_importer]


def csv_importer(institution_id: str):
    """The (cached) CSV importer instance for an institution; ValueError if none."""
    inst = get(institution_id)
    if not inst.csv_importer:
        raise ValueError(f"No CSV importer for {inst.name} yet.")
    if inst.id not in _IMPORTERS:
        module_name, _, attr = inst.csv_importer.partition(":")
        _IMPORTERS[inst.id] = getattr(importlib.import_module(module_name), attr)()
    return _IMPORTERS[inst.id]


_MAX_ID = 32  # the institution id rule: ^[a-z][a-z0-9_-]{0,31}$ (canonical.INSTITUTION_PATTERN)
_NO_DECOMPOSITION = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "ß": "ss", "đ": "d"})


def slug_id(name: str) -> str:
    """A generic institution id from a free-form name: lower case, ASCII, words joined
    by "-", at most 32 characters, starting with a letter ("ING Bank Śląski S.A." ->
    "ing-bank-slaski-s-a"). Empty when the name holds no letters or digits."""
    text = unicodedata.normalize("NFKD", (name or "").translate(_NO_DECOMPOSITION))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if slug and not slug[0].isalpha():
        slug = f"bank-{slug}"
    return slug[:_MAX_ID].rstrip("-")


def from_aspsp(aspsp_name: str | None) -> Institution | None:
    """The institution an Enable Banking ASPSP name belongs to (first pattern hit)."""
    low = (aspsp_name or "").lower()
    if not low:
        return None
    for inst in all_institutions():
        if any(p in low for p in inst.aspsp_patterns):
            return inst
    return None


for _inst in BUILTIN:
    register(_inst)
