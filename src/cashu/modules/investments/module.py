"""Investments module spec (registered in ``cashu.core.modules``)."""

from __future__ import annotations

from cashu.core.account_types import AccountTypeInfo, NetWorthBucket
from cashu.core.institutions import Institution
from cashu.core.modules import ModuleSpec

from . import api, cli, perf_api, research_api
from .models import TABLES
from .networth import InvestmentsContributor
from .setup import setup_status
from .store.transactions import BROKERAGE

api.router.include_router(perf_api.router)  # /investments/performance[/attribution]
api.router.include_router(research_api.router)  # /investments/research[/summary|/runs|/{id}]
api.router.include_router(research_api.topics_router)  # /investments/topics/{segment}/thesis (P9)

MODULE = ModuleSpec(
    id="investments",
    name="Inwestycje",
    description="Rachunki maklerskie, alokacja vs strategia, sygnały, dziennik decyzji",
    name_en="Investments",
    description_en="Brokerage accounts, allocation vs strategy, signals, decision journal",
    available=True,
    tables=TABLES,
    router=api.router,
    cli_module=cli.register_module,
    cli_name="invest",
    cli_help="Investments: brokerage accounts, imports, positions, strategy, rules.",
    networth=InvestmentsContributor(),
    networth_buckets=(NetWorthBucket("investments", "Inwestycje", 5, label_en="Investments"),),
    account_types=(
        AccountTypeInfo(
            BROKERAGE,
            "investments",
            "Rachunki maklerskie",
            bucket="investments",
            label_en="Brokerage accounts",
        ),
    ),
    # Display names only: imports go through the cashU format or a CSV mapping.
    institutions=(
        Institution("dif", "broker", "DIF Broker"),
        Institution("xtb", "broker", "XTB"),
        Institution("binance", "exchange", "Binance"),
        Institution("zonda", "exchange", "Zonda"),
    ),
    setup_status=setup_status,
    skill="/investments-setup",
)
