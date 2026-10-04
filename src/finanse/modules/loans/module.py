"""Loans module spec (registered in ``finanse.core.modules``)."""

from __future__ import annotations

from finanse.core.account_types import AccountTypeInfo, NetWorthBucket
from finanse.core.modules import ModuleSpec

from . import api, cli
from .models import Loan
from .networth import LoansContributor

MODULE = ModuleSpec(
    id="loans",
    name="Kredyty",
    description=(
        "Hipoteka i inne kredyty: harmonogram, odsetki, saldo w czasie. "
        "Wiele kredytów na profil."
    ),
    tables=(Loan,),
    router=api.router,
    cli=cli.register,
    cli_help="Loans: amortization schedules for mortgages and other loans.",
    networth=LoansContributor(),
    networth_buckets=(
        NetWorthBucket("mortgage", "Hipoteka", 30, liability=True),
        NetWorthBucket("loan", "Kredyt", 40, liability=True),
    ),
    account_types=(
        AccountTypeInfo(
            "mortgage", "loans", "Hipoteka", sign="liability", liquid=False, bucket="mortgage"
        ),
        AccountTypeInfo("loan", "loans", "Pożyczki", sign="liability", liquid=False, bucket="loan"),
    ),
    skill="/loans-setup",
)
