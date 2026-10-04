"""Institution registry: banks, brokers and exchanges an account can belong to.

``accounts.bank`` stores an institution id from this registry (the upstream
``Bank`` enum values ``mbank``, ``erste``, ``pekao``, ``manual`` stay valid ids).
An entry says how to recognise and read that institution's data:

- ``kind``: ``bank`` | ``broker`` | ``exchange`` | ``manual``;
- ``name``: display name;
- ``csv_importer``: ``"package.module:ClassName"`` of its statement parser (imported
  lazily, so core never imports a module's code); None = no CSV import yet;
- ``aspsp_patterns``: lowercase substrings of the Enable Banking ASPSP name that
  map an Open Banking session to this institution.

Adding a bank = one ``Institution`` entry here (or registered by a module) + its
parser config in ``modules/budget/ingestion/csv_import/`` (see AGENTS.md).
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any, Literal

Kind = Literal["bank", "broker", "exchange", "manual"]

MANUAL = "manual"  # manually tracked positions, the cash pool, loans without a bank feed

_CSV = "finanse.modules.budget.ingestion.csv_import"


@dataclass(frozen=True)
class Institution:
    id: str
    kind: Kind
    name: str
    csv_importer: str | None = None
    aspsp_patterns: tuple[str, ...] = ()
    country: str = "PL"


BUILTIN: tuple[Institution, ...] = (
    Institution("mbank", "bank", "mBank", f"{_CSV}.mbank:MBankImporter", ("mbank",)),
    # Erste Bank Polska = the former Santander Bank Polska (legacy exports too).
    Institution(
        "erste", "bank", "Erste Bank Polska", f"{_CSV}.erste:ErsteImporter", ("erste", "santander")
    ),
    Institution("pekao", "bank", "Bank Pekao", f"{_CSV}.pekao:PekaoImporter", ("pekao",)),
    # Open Banking only until the CSV parser lands (needs a sample export).
    Institution("millennium", "bank", "Bank Millennium", None, ("millennium",)),
    Institution(MANUAL, "manual", "Ręcznie"),
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
    """Display name, or the id itself for an id no entry knows (never raises)."""
    _ensure_loaded()
    inst = _REGISTRY.get(institution_id)
    return inst.name if inst else institution_id


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
