"""Investments domain contract (pure data, no database, no web).

Contract note (stable names; changes are recorded in ``stock/docs/fork/progress/F2-D.md``):

- Port of the Kompas (Dart) core model and portfolio contracts (``snapshot.dart``, ``bucket_def.dart``)
  in snake_case, including the Stage 1 review fixes R1-R15 and the Stage 2 extensions (asset class
  ``claim``, ``ValuationMode.MANUAL`` with ``ManualValuation``, ``InstrumentStatus``, ``InstrumentRename``).
- Ids are ``str`` aliases (``ProfileId``, ``AccountId``, ``InstrumentId``, ``TxnId``); ``CalendarDate`` is
  ``datetime.date``; money is ``Decimal`` (never float), ratios and weights are ``float``.
- ``Currency`` is a validated ``str`` subclass (equal to the plain code). Amounts in different
  currencies are never added; conversion happens only in valuation through an ``FxLookup``
  (``rate`` = units of base per 1 unit of quote, PLN per USD for NBP).
- Enums are ``StrEnum`` whose values are the snake_case wire names (``AssetClass("treasury_bond")``).
- Every type is a frozen dataclass with value equality. Sequences are tuples, sets frozensets,
  mappings plain dicts (read-only by convention).
- Warnings (``PortfolioWarning`` subclasses) carry a stable ``kind`` and an English ``message``; the
  portfolio math never raises on incomplete history, it records warnings.
- Pipeline (in ``portfolio``): ``build_snapshot`` -> ``value_portfolio`` -> ``allocate``; the rules engine
  reads ``ValuedPortfolio``, ``AllocationResult`` (incl. ``unclassified``), ``MarketView`` and ``FxLookup``.
"""

from .buckets import (
    GENERIC_BUCKET_IDS,
    AllocationPlan,
    BucketDef,
    BucketMatch,
    is_generic_bucket,
)
from .enums import (
    AccountWrapper,
    AssetClass,
    DecisionAction,
    InstrumentStatus,
    SignalSeverity,
    SignalStatus,
    TxnSource,
    TxnType,
    ValuationMode,
    default_valuation_mode,
    severity_rank,
)
from .fx import DEFAULT_MAX_FX_AGE_DAYS, FxLookup, FxQuote
from .instrument import (
    AliasNamespace,
    Instrument,
    InstrumentAlias,
    InstrumentRename,
    ManualValuation,
    placeholder_instrument,
)
from .market_data import FxRate, PriceBar
from .plan import (
    BUY_PLANS,
    HELD_ONLY_PLANS,
    PLAN_LABEL_HELD,
    PLAN_LABEL_WATCHED,
    PLAN_VALUES,
    effective_plan,
    is_plan,
    opened_on,
    plan_label,
)
from .snapshot import (
    AllocationResult,
    BucketAllocation,
    CashBalance,
    DatedAmount,
    DatedPrice,
    Holding,
    MarketView,
    OpenLot,
    PortfolioSnapshot,
    RealizedTrade,
    ValuedCash,
    ValuedHolding,
    ValuedPortfolio,
    ValuedRealizedTrade,
)
from .transaction import Transaction, chronological_key
from .values import (
    DIVISION_SCALE,
    EPOCH,
    EXACT_CONTEXT,
    AccountId,
    CalendarDate,
    Currency,
    ImportBatchId,
    InstrumentId,
    Money,
    ProfileId,
    TxnId,
    days_between,
    divided_by,
    exact,
    exact_decimals,
    ratio,
)
from .warnings import (
    ALL_WARNING_TYPES,
    CashHistoryGap,
    FrozenValuedAtZero,
    HistoryGap,
    InvalidTransaction,
    LastKnownPriceUsed,
    MissingCostBasis,
    MissingFxRate,
    MissingInstrument,
    MissingManualValuation,
    MissingPrice,
    MixedLotCurrencies,
    PortfolioWarning,
    RealizedCurrencyMismatch,
    StaleFxRate,
    StalePrice,
    UnknownCostBasis,
)

__all__ = [
    "ALL_WARNING_TYPES",
    "BUY_PLANS",
    "DEFAULT_MAX_FX_AGE_DAYS",
    "DIVISION_SCALE",
    "EPOCH",
    "EXACT_CONTEXT",
    "GENERIC_BUCKET_IDS",
    "HELD_ONLY_PLANS",
    "PLAN_LABEL_HELD",
    "PLAN_LABEL_WATCHED",
    "PLAN_VALUES",
    "AccountId",
    "AccountWrapper",
    "AliasNamespace",
    "AllocationPlan",
    "AllocationResult",
    "AssetClass",
    "BucketAllocation",
    "BucketDef",
    "BucketMatch",
    "CalendarDate",
    "CashBalance",
    "CashHistoryGap",
    "Currency",
    "DatedAmount",
    "DatedPrice",
    "DecisionAction",
    "FrozenValuedAtZero",
    "FxLookup",
    "FxQuote",
    "FxRate",
    "HistoryGap",
    "Holding",
    "ImportBatchId",
    "Instrument",
    "InstrumentAlias",
    "InstrumentId",
    "InstrumentRename",
    "InstrumentStatus",
    "InvalidTransaction",
    "LastKnownPriceUsed",
    "ManualValuation",
    "MarketView",
    "MissingCostBasis",
    "MissingFxRate",
    "MissingInstrument",
    "MissingManualValuation",
    "MissingPrice",
    "MixedLotCurrencies",
    "Money",
    "OpenLot",
    "PortfolioSnapshot",
    "PortfolioWarning",
    "PriceBar",
    "ProfileId",
    "RealizedCurrencyMismatch",
    "RealizedTrade",
    "SignalSeverity",
    "SignalStatus",
    "StaleFxRate",
    "StalePrice",
    "Transaction",
    "TxnId",
    "TxnSource",
    "TxnType",
    "UnknownCostBasis",
    "ValuationMode",
    "ValuedCash",
    "ValuedHolding",
    "ValuedPortfolio",
    "ValuedRealizedTrade",
    "chronological_key",
    "days_between",
    "default_valuation_mode",
    "divided_by",
    "effective_plan",
    "exact",
    "exact_decimals",
    "is_generic_bucket",
    "is_plan",
    "opened_on",
    "placeholder_instrument",
    "plan_label",
    "ratio",
    "severity_rank",
]
