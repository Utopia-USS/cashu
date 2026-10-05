"""Budget module spec (registered in ``finanse.core.modules``)."""

from __future__ import annotations

from finanse.core.account_types import AccountTypeInfo
from finanse.core.modules import ModuleSpec

from . import api, cli
from .models import CategoryRule, ImportBatch, Transaction
from .networth import CashContributor
from .setup import setup_status

MODULE = ModuleSpec(
    id="budget",
    name="Budżet domowy",
    description=(
        "Konta bankowe, wydatki po kategoriach, przepływy i subskrypcje. "
        "Import CSV z banku (mBank, Erste, Pekao) lub Open Banking."
    ),
    tables=(Transaction, CategoryRule, ImportBatch),
    router=api.router,
    cli=cli.register,
    cli_module=cli.register_module,
    cli_help="Budget: statement import, categories, cash pool, month close, Open Banking.",
    networth=CashContributor(),
    account_types=(
        AccountTypeInfo("checking", "budget", "Konta osobiste"),
        AccountTypeInfo("savings", "budget", "Oszczędności"),
        AccountTypeInfo("credit", "budget", "Karty kredytowe", sign="credit"),
        AccountTypeInfo("cash", "budget", "Gotówka"),
    ),
    setup_status=setup_status,
    skill="/budget-setup",
)
