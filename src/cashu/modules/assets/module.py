"""Assets module spec (registered in ``cashu.core.modules``)."""

from __future__ import annotations

from cashu.core.account_types import AccountTypeInfo, NetWorthBucket
from cashu.core.modules import ModuleSpec

from . import api, cli
from .models import AssetDetails, Depreciation
from .networth import AssetsContributor
from .setup import setup_status

MODULE = ModuleSpec(
    id="assets",
    name="Majątek",
    description="Nieruchomości, auta i inne aktywa wyceniane ręcznie",
    tables=(Depreciation, AssetDetails),
    router=api.router,
    cli=cli.register,
    cli_help="Assets: manually valued positions and depreciating vehicles.",
    networth=AssetsContributor(),
    networth_buckets=(
        NetWorthBucket("property", "Nieruchomości", 10),
        NetWorthBucket("vehicle", "Auto", 20),
    ),
    account_types=(
        AccountTypeInfo("property", "assets", "Nieruchomości", liquid=False, bucket="property"),
        AccountTypeInfo("vehicle", "assets", "Auto", liquid=False, bucket="vehicle"),
        AccountTypeInfo("investment", "assets", "Inwestycje"),
        AccountTypeInfo("other", "assets", "Inne"),
    ),
    setup_status=setup_status,
    skill="/assets-setup",
)
