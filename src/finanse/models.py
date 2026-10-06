"""Every table of the app in one place (facade).

Tables live with their owner: core (``Profile``, ``ProfileModule``, ``Account``,
``Balance``), and the modules
(budget: ``Transaction``, ``CategoryRule``, ``ImportBatch``; assets:
``Depreciation``, ``AssetDetails``; loans: ``Loan``; investments: the ``Inv*`` tables in
``modules/investments/models.py``) and the agent layer (``Proposal``, ``McpCall``,
``Review`` in ``core/agent_models.py``) and the connectors (``Connector``, ``ConnectorBinding``,
``ConnectorRun`` in ``core/connectors/models.py``). Importing this module registers all of them on
``SQLModel.metadata`` (used by ``init_db`` and the Alembic environment) and keeps
``from finanse.models import ...`` working for scripts.
"""

from __future__ import annotations

from .core.agent_models import McpCall, Proposal, Review
from .core.connectors.models import Connector, ConnectorBinding, ConnectorRun
from .core.models import Account, AccountType, Balance, Profile, ProfileModule, Source
from .modules.assets.models import AssetDetails, Depreciation
from .modules.budget.models import CategoryRule, ImportBatch, Transaction
from .modules.investments import (
    models as investments_models,  # noqa: F401  (registers the inv_ tables)
)
from .modules.loans.models import Loan

__all__ = [
    "Account",
    "AccountType",
    "AssetDetails",
    "Balance",
    "CategoryRule",
    "Connector",
    "ConnectorBinding",
    "ConnectorRun",
    "Depreciation",
    "ImportBatch",
    "Loan",
    "McpCall",
    "Profile",
    "ProfileModule",
    "Proposal",
    "Review",
    "Source",
    "Transaction",
]
