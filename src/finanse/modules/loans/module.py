"""Loans module spec (registered in ``finanse.core.modules``)."""

from __future__ import annotations

from finanse.core.account_types import AccountTypeInfo, NetWorthBucket
from finanse.core.modules import ModuleSpec

from . import api, cli
from .models import Loan
from .networth import LoansContributor
from .patterns import INSTALLMENT_PHRASES, payment_patterns
from .setup import setup_status

MODULE = ModuleSpec(
    id="loans",
    name="Kredyty",
    description="Hipoteka i kredyty: harmonogram, odsetki, saldo w czasie",
    tables=(Loan,),
    router=api.router,
    cli=cli.register,
    cli_module=cli.register_module,
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
    # Installments are loan repayments, never subscriptions: phrases for every
    # profile, plus each loan's own lender account / title phrase.
    text_rules=INSTALLMENT_PHRASES,
    payment_patterns=payment_patterns,
    not_subscription_categories=frozenset({"loans"}),
    setup_status=setup_status,
    skill="/loans-setup",
)
