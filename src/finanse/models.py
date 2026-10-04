"""Every table of the app in one place (facade).

Tables live with their owner: core (``Profile``, ``ProfileModule``, ``Account``,
``Balance``), and the modules
(budget: ``Transaction``, ``CategoryRule``, ``ImportBatch``; assets:
``Depreciation``; loans: ``Loan``; investments: the ``Inv*`` tables in
``modules/investments/models.py``). Importing this module registers all of them on
``SQLModel.metadata`` (used by ``init_db`` and the Alembic environment) and keeps
``from finanse.models import ...`` working for scripts.
"""

from __future__ import annotations

from .core.models import Account, AccountType, Balance, Profile, ProfileModule, Source
from .modules.assets.models import Depreciation
from .modules.budget.models import CategoryRule, ImportBatch, Transaction
from .modules.investments import (
    models as investments_models,  # noqa: F401  (registers the inv_ tables)
)
from .modules.loans.models import Loan

__all__ = [
    "Account",
    "AccountType",
    "Balance",
    "CategoryRule",
    "Depreciation",
    "ImportBatch",
    "Loan",
    "Profile",
    "ProfileModule",
    "Source",
    "Transaction",
]
