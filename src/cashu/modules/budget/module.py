"""Budget module spec (registered in ``cashu.core.modules``)."""

from __future__ import annotations

from cashu.core.account_types import AccountTypeInfo
from cashu.core.modules import ModuleSpec

from . import api, cli
from .models import CategoryRule, ImportBatch, Transaction
from .networth import CashContributor
from .setup import setup_status


def _recategorize(session, profile_id: int) -> dict:
    from .service import categorize_all

    return categorize_all(session, profile_id=profile_id)


MODULE = ModuleSpec(
    id="budget",
    name="Budżet domowy",
    description="Konta, wydatki, przepływy, subskrypcje · CSV lub Open Banking",
    name_en="Home budget",
    description_en="Accounts, expenses, cash flow, subscriptions · CSV or Open Banking",
    tables=(Transaction, CategoryRule, ImportBatch),
    router=api.router,
    cli=cli.register,
    cli_module=cli.register_module,
    cli_help="Budget: statement import, categories, cash pool, month close, Open Banking.",
    networth=CashContributor(),
    account_types=(
        AccountTypeInfo("checking", "budget", "Konta osobiste", label_en="Checking accounts"),
        AccountTypeInfo("savings", "budget", "Oszczędności", label_en="Savings"),
        AccountTypeInfo(
            "credit", "budget", "Karty kredytowe", sign="credit", label_en="Credit cards"
        ),
        AccountTypeInfo("cash", "budget", "Gotówka", label_en="Cash"),
    ),
    recategorize=_recategorize,
    setup_status=setup_status,
    skill="/budget-setup",
)
