"""Module registry: the contract every module implements (``ModuleSpec``).

A module lives in ``finanse/modules/<id>/`` and exports ``MODULE: ModuleSpec`` from
``finanse/modules/<id>/module.py``. The registry imports those lazily (on first
use, never at import time of core), so modules may depend on core freely while
core never imports a module's internals. Cross-module needs go through the
protocols declared here and in ``core.networth`` / ``core.account_types``.

What a module declares:

- ``id``, Polish ``name`` and one-line ``description`` (the profile wizard),
  ``depends_on`` (other module ids, enabled together);
- ``tables``: its SQLModel tables;
- ``router``: FastAPI router, mounted under ``/api/p/{slug}`` (and the legacy
  ``/api`` aliases of the default profile);
- ``cli``: ``register(app)`` adding its (top-level, upstream-compatible) Typer
  commands to an app; ``cli_module``: the commands of its sub-app
  ``finanse <id> ...`` (defaults to ``cli``); ``cli_name``: the sub-app's name
  when it is not the id (``finanse invest ...``); a module may ship only a sub-app;
- ``networth``: optional ``NetWorthContributor`` (values the accounts it owns);
- ``account_types`` / ``networth_buckets``: registered with ``core.account_types``;
- ``institutions``: extra institutions (e.g. brokers) for ``core.institutions``;
- ``text_rules`` / ``payment_patterns`` / ``not_subscription_categories``: what the
  module tells transaction categorization (budget) about payments it owns, e.g.
  loans claim their installments so they are never "subscriptions";
- ``recategorize(session, profile_id)``: the module that owns transaction categorization (budget)
  re-runs it for a profile, so another module whose configuration changes what matches (a loan's
  installment phrase) can apply it without importing that module;
- ``setup_status(session, profile_id)``: steps of the module's blank page;
- ``skill``: the Claude Code setup skill command (``/budget-setup``).
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from . import account_types, institutions

if TYPE_CHECKING:
    from sqlmodel import Session

    from .networth import NetWorthContributor

StepStatus = Literal["done", "on", "todo"]
SetupState = Literal["empty", "partial", "ready"]

# Display order (wizard cards, tab groups). Module ids are also package names.
MODULE_IDS = ("budget", "assets", "loans", "investments")


@dataclass(frozen=True)
class SetupAction:
    kind: str  # "cli" (target = a command to run) | "view" (target = a frontend view id)
    label: str  # Polish (UI data)
    target: str

    def as_dict(self) -> dict:
        return {"kind": self.kind, "label": self.label, "target": self.target}


@dataclass(frozen=True)
class SetupStep:
    id: str
    title: str  # Polish (UI data)
    description: str  # Polish (UI data)
    done: bool
    actions: tuple[SetupAction, ...] = ()
    # An optional step (e.g. a car) never counts toward the module state and is never "on": it is
    # "done" when done, else "todo" (the UI tags it "opcjonalnie").
    optional: bool = False


@dataclass(frozen=True)
class SetupStatus:
    """Blank-page steps; the first required step not done is "on", the rest "todo". The state counts
    required steps only: "ready" when every one is done, "empty" when none is."""

    steps: tuple[SetupStep, ...]

    @property
    def state(self) -> SetupState:
        required = [s for s in self.steps if not s.optional]
        done = sum(s.done for s in required)
        if required and done == len(required):
            return "ready"
        return "partial" if done else "empty"

    def step_dicts(self) -> list[dict]:
        out: list[dict] = []
        current_given = False
        for s in self.steps:
            if s.done:
                status: StepStatus = "done"
            elif not current_given and not s.optional:
                status, current_given = "on", True
            else:
                status = "todo"
            out.append({
                "id": s.id,
                "title": s.title,
                "description": s.description,
                "status": status,
                "optional": s.optional,
                "actions": [a.as_dict() for a in s.actions],
            })
        return out


@dataclass(frozen=True)
class PaymentPattern:
    """A payment a module owns, for categorization: an outflow to
    ``counterparty_iban`` or whose text contains ``text`` (normalized: uppercase,
    no diacritics) gets ``category``."""

    category: str
    counterparty_iban: str | None = None  # compared by core.text.iban_key
    text: str | None = None


@dataclass
class ModuleSpec:
    id: str
    name: str  # Polish (UI data)
    description: str  # Polish (UI data)
    depends_on: tuple[str, ...] = ()
    available: bool = True  # False: listed (wizard) but not implemented in this build
    tables: tuple[type, ...] = ()
    router: Any = None  # fastapi.APIRouter
    cli: Callable[[Any], None] | None = None  # register(typer_app): top-level commands
    cli_module: Callable[[Any], None] | None = None  # commands of `finanse <id> ...` (default: cli)
    cli_help: str = ""
    cli_name: str | None = None  # sub-app name (default: the module id)
    networth: NetWorthContributor | None = None
    account_types: tuple[account_types.AccountTypeInfo, ...] = ()
    networth_buckets: tuple[account_types.NetWorthBucket, ...] = ()
    institutions: tuple[institutions.Institution, ...] = ()  # e.g. brokers
    # Categorization hooks (used by the budget module for every profile):
    text_rules: tuple[tuple[str, str], ...] = ()  # (phrase in normalized text, category)
    payment_patterns: Callable[[Session, int], list[PaymentPattern]] | None = None
    not_subscription_categories: frozenset[str] = frozenset()
    recategorize: Callable[[Session, int], Any] | None = None
    setup_status: Callable[[Session, int], SetupStatus] | None = None
    skill: str | None = None  # Claude Code skill command, e.g. "/budget-setup"
    extra: dict[str, Any] = field(default_factory=dict)


def cli_prefix(session: Session, profile_id: int) -> str:
    """``finanse --profile <slug>`` for copyable setup commands of a profile; in the packaged app
    the bundled binary's absolute path (there is no ``finanse`` on PATH), quoted for the shell."""
    import shlex

    from . import runtime
    from .models import Profile

    profile = session.get(Profile, profile_id)
    program = runtime.cli_program()
    if profile is None:
        return shlex.join(program)
    return shlex.join([*program, "--profile", profile.slug])


def _investments_placeholder_setup(_session: Session, _profile_id: int) -> SetupStatus:
    return SetupStatus(steps=(
        SetupStep(
            "broker_account",
            "Dodaj rachunek maklerski",
            "Broker + opakowanie (zwykłe, IKE, IKZE).",
            done=False,
        ),
        SetupStep(
            "strategy",
            "Zapisz strategię",
            "strategy.yaml i strategy.md; wywiad w Claude Code albo szablon.",
            done=False,
        ),
        SetupStep(
            "first_import",
            "Pierwsza wpłata lub import",
            "Dodaj transakcję ręcznie albo zaimportuj CSV od brokera.",
            done=False,
        ),
        SetupStep(
            "classify",
            "Sklasyfikuj instrumenty",
            "Klasa aktywów i koszyk dla każdego instrumentu.",
            done=False,
        ),
    ))


# Shown in the wizard before the module's own spec lands (it is built in
# ``finanse/modules/investments/``; once that package exports ``module.MODULE``,
# the real spec replaces this one).
_PLACEHOLDERS: dict[str, ModuleSpec] = {
    "investments": ModuleSpec(
        id="investments",
        name="Inwestycje",
        description="Rachunki maklerskie, alokacja vs strategia, sygnały, dziennik decyzji",
        available=False,
        setup_status=_investments_placeholder_setup,
        skill="/investments-setup",
    ),
}

_registry: dict[str, ModuleSpec] | None = None


def _load(module_id: str) -> ModuleSpec | None:
    name = f"finanse.modules.{module_id}.module"
    try:
        mod = importlib.import_module(name)
    except ModuleNotFoundError as e:
        if e.name not in (name, f"finanse.modules.{module_id}"):
            raise  # a real import error inside the module
        return _PLACEHOLDERS.get(module_id)
    spec = getattr(mod, "MODULE", None)
    return spec if isinstance(spec, ModuleSpec) else _PLACEHOLDERS.get(module_id)


def register(spec: ModuleSpec) -> None:
    """Add a module (and its account types / net-worth buckets) to the registry."""
    reg = registry()
    reg[spec.id] = spec
    _register_metadata(spec)


def _register_metadata(spec: ModuleSpec) -> None:
    for b in spec.networth_buckets:
        account_types.register_bucket(b)
    for t in spec.account_types:
        account_types.register_type(t)
    for inst in spec.institutions:
        institutions.register(inst)


def registry() -> dict[str, ModuleSpec]:
    """All known modules (loaded on first call), in display order."""
    global _registry
    if _registry is None:
        loaded: dict[str, ModuleSpec] = {}
        for module_id in MODULE_IDS:
            spec = _load(module_id)
            if spec is not None:
                loaded[module_id] = spec
                _register_metadata(spec)
        _registry = loaded
    return _registry


def all_modules() -> list[ModuleSpec]:
    return list(registry().values())


def get(module_id: str) -> ModuleSpec:
    try:
        return registry()[module_id]
    except KeyError:
        raise KeyError(f"Unknown module {module_id!r}") from None


def text_rules() -> list[tuple[str, str]]:
    """Static (phrase, category) rules registered by modules, in module order."""
    return [rule for spec in all_modules() for rule in spec.text_rules]


def payment_patterns(session: Session, profile_id: int) -> list[PaymentPattern]:
    """Per-profile payment patterns registered by modules (e.g. each loan's lender
    account), whatever modules the profile has enabled: data a module created keeps
    being recognised."""
    out: list[PaymentPattern] = []
    for spec in all_modules():
        if spec.payment_patterns is not None:
            out.extend(spec.payment_patterns(session, profile_id))
    return out


def recategorize(session: Session, profile_id: int) -> bool:
    """Re-run transaction categorization of the profile through every module that provides it
    (``ModuleSpec.recategorize``); False when none does. Runs inside the caller's transaction."""
    ran = False
    for spec in all_modules():
        if spec.recategorize is not None:
            spec.recategorize(session, profile_id)
            ran = True
    return ran


def not_subscription_categories() -> frozenset[str]:
    out: set[str] = set()
    for spec in all_modules():
        out |= spec.not_subscription_categories
    return frozenset(out)


def with_dependencies(module_ids: list[str] | tuple[str, ...]) -> list[str]:
    """``module_ids`` plus everything they depend on, in display order."""
    reg = registry()
    wanted: set[str] = set()
    stack = list(module_ids)
    while stack:
        mid = stack.pop()
        if mid in wanted:
            continue
        wanted.add(mid)
        stack.extend(get(mid).depends_on)
    return [m for m in reg if m in wanted]
