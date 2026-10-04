"""Every table of the app in one place (facade).

Tables live with their owner: core (``Account``, ``Balance``), and the modules
(budget: ``Transaction``, ``CategoryRule``, ``ImportBatch``; assets:
``Depreciation``; loans: ``Loan``). Importing this module registers all of them on
``SQLModel.metadata`` (used by ``init_db`` and the Alembic environment) and keeps
``from finanse.models import ...`` working for scripts.
"""

from __future__ import annotations

from .core.models import Account, AccountType, Balance, Bank, Source
from .modules.assets.models import Depreciation
from .modules.budget.models import CategoryRule, ImportBatch, Transaction
from .modules.loans.models import Loan

__all__ = [
    "Account",
    "AccountType",
    "Balance",
    "Bank",
    "CategoryRule",
    "Depreciation",
    "ImportBatch",
    "Loan",
    "Source",
    "Transaction",
]
