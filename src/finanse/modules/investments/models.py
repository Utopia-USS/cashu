"""Investments tables (prefixed ``inv_``: the budget module already owns ``transactions``).

Shared reference data (every profile sees the same rows): instruments, their aliases, daily price bars
and FX rates. Everything else belongs to one profile, through its brokerage account (transactions,
broker position snapshots, account settings) or a ``profile_id`` (renames, manual valuations, strategy
versions, rule runs, signals, notifications, decisions, theses, import batches).

Money and quantities are exact decimal text (``DecimalText``), enum values are their wire names
(``finanse.modules.investments.domain`` enums). The pure domain uses ``str`` ids; the persistence layer
converts with ``str(pk)`` / ``int(id)`` (``store.convert``).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from sqlalchemy import JSON, Column, Index, UniqueConstraint, text
from sqlmodel import Field, SQLModel

from finanse.core.models import profile_fk_column, utcnow
from finanse.core.types import DecimalText


def _decimal(nullable: bool = True) -> Any:
    return Field(default=None, sa_column=Column(DecimalText, nullable=nullable))


def _json_list() -> Any:
    return Field(default_factory=list, sa_column=Column(JSON, nullable=False))


def _json_dict() -> Any:
    return Field(default_factory=dict, sa_column=Column(JSON, nullable=False))


# --------------------------------------------------------------------------- #
# Shared reference data
# --------------------------------------------------------------------------- #


class InvInstrument(SQLModel, table=True):
    """A security, fund, bond, claim or cash-like instrument (``domain.Instrument``)."""

    __tablename__ = "inv_instruments"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    currency: str  # trading / pricing currency
    asset_class: str  # domain.AssetClass
    symbol: str | None = Field(default=None, index=True)
    isin: str | None = Field(default=None, index=True)
    mic: str | None = None
    region: str | None = None
    sector: str | None = None
    tags: list[str] = _json_list()
    needs_classification: bool = Field(default=False)
    valuation_mode: str  # domain.ValuationMode
    status: str = Field(default="active")  # domain.InstrumentStatus
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


class InvInstrumentAlias(SQLModel, table=True):
    """An external identifier, unique per namespace across all instruments (``isin``, ``yahoo``,
    ``stooq``, or a broker id for broker symbols)."""

    __tablename__ = "inv_instrument_aliases"
    __table_args__ = (UniqueConstraint("namespace", "value", name="uq_inv_alias_namespace_value"),)

    id: int | None = Field(default=None, primary_key=True)
    instrument_id: int = Field(foreign_key="inv_instruments.id", index=True)
    namespace: str
    value: str
    guessed: bool = Field(default=False)  # inferred (e.g. a Yahoo symbol from an exchange hint)
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvPriceBar(SQLModel, table=True):
    """One daily bar, prices in the instrument currency."""

    __tablename__ = "inv_price_bars"
    __table_args__ = (UniqueConstraint("instrument_id", "date", name="uq_inv_price_bar"),)

    id: int | None = Field(default=None, primary_key=True)
    instrument_id: int = Field(foreign_key="inv_instruments.id")
    date: dt.date
    close: Decimal = _decimal(nullable=False)
    open: Decimal | None = _decimal()
    high: Decimal | None = _decimal()
    low: Decimal | None = _decimal()
    volume: int | None = None
    currency: str | None = None  # quote currency the source reported (None: not reported)
    source: str
    fetched_at: dt.datetime | None = None  # UTC; the split check compares it with split dates


class InvFxRate(SQLModel, table=True):
    """``rate`` units of ``base`` per 1 ``quote`` (NBP table A: PLN per 1 USD)."""

    __tablename__ = "inv_fx_rates"
    __table_args__ = (UniqueConstraint("base", "quote", "date", name="uq_inv_fx_rate"),)

    id: int | None = Field(default=None, primary_key=True)
    base: str
    quote: str
    date: dt.date
    rate: Decimal = _decimal(nullable=False)
    source: str
    fetched_at: dt.datetime | None = None


# --------------------------------------------------------------------------- #
# Accounts, imports, transactions (profile-scoped through the account)
# --------------------------------------------------------------------------- #


class InvAccountSettings(SQLModel, table=True):
    """Investments settings of a brokerage account (a core ``accounts`` row of type ``brokerage``)."""

    __tablename__ = "inv_account_settings"

    account_id: int = Field(foreign_key="accounts.id", primary_key=True)
    wrapper: str = Field(default="regular")  # domain.AccountWrapper
    importer: str | None = None  # remembered importer: "finanse" | "generic_csv"
    mapping_yaml: str | None = None  # remembered generic CSV mapping
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


class InvImportBatch(SQLModel, table=True):
    """One committed import file."""

    __tablename__ = "inv_import_batches"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_import_batches"))
    account_id: int = Field(foreign_key="accounts.id", index=True)
    importer: str  # broker id of the importer that parsed the file
    broker: str  # effective broker id (alias namespace): the file's `source` or the importer's id
    file_name: str
    file_sha256: str = Field(index=True)
    archive_path: str | None = None  # relative to the data dir
    txn_count: int = 0  # inserted transactions
    duplicate_count: int = 0
    position_count: int = 0
    rename_count: int = 0
    status_change_count: int = 0
    instrument_count: int = 0  # new instruments
    correction_count: int = 0  # reconciliation corrections applied with the commit
    warnings: list[dict] = _json_list()  # [{message, row, kind}]
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvTransaction(SQLModel, table=True):
    """One broker account event (``domain.Transaction``)."""

    __tablename__ = "inv_transactions"
    __table_args__ = (UniqueConstraint("account_id", "dedup_hash", name="uq_inv_txn_account_hash"),)

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    type: str  # domain.TxnType
    trade_date: dt.date = Field(index=True)
    settle_date: dt.date | None = None
    instrument_id: int | None = Field(default=None, foreign_key="inv_instruments.id", index=True)
    quantity: Decimal | None = _decimal()
    price: Decimal | None = _decimal()
    currency: str
    gross_amount: Decimal = _decimal(nullable=False)
    fee: Decimal = _decimal(nullable=False)
    tax: Decimal = _decimal(nullable=False)
    cash_amount: Decimal = _decimal(nullable=False)
    cash_currency: str
    fx_rate: Decimal | None = _decimal()
    split_ratio: Decimal | None = _decimal()
    note: str | None = None
    source: str = Field(default="import")  # domain.TxnSource
    import_batch_id: int | None = Field(
        default=None, foreign_key="inv_import_batches.id", index=True
    )
    external_ref: str | None = None
    dedup_hash: str
    # Chronological rank: rows of one import get strictly increasing stamps in file order of time,
    # so same-day trades keep their order (domain.chronological_key).
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvPositionSnapshot(SQLModel, table=True):
    """A broker position line (from an import): what the broker says the account held."""

    __tablename__ = "inv_position_snapshots"
    __table_args__ = (
        UniqueConstraint("account_id", "instrument_id", "as_of", name="uq_inv_position_snapshot"),
    )

    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", index=True)
    instrument_id: int = Field(foreign_key="inv_instruments.id")
    as_of: dt.date
    quantity: Decimal = _decimal(nullable=False)
    currency: str
    avg_price: Decimal | None = _decimal()
    market_value: Decimal | None = _decimal()
    import_batch_id: int | None = Field(default=None, foreign_key="inv_import_batches.id")
    created_at: dt.datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Profile-scoped reference data
# --------------------------------------------------------------------------- #


class InvInstrumentRename(SQLModel, table=True):
    """Ticker change / merger into a successor (lots carry over), from an import."""

    __tablename__ = "inv_instrument_renames"
    __table_args__ = (
        UniqueConstraint(
            "profile_id", "date", "old_instrument_id", "new_instrument_id", name="uq_inv_rename"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_instrument_renames"))
    date: dt.date
    old_instrument_id: int = Field(foreign_key="inv_instruments.id")
    new_instrument_id: int = Field(foreign_key="inv_instruments.id")
    note: str | None = None
    import_batch_id: int | None = Field(default=None, foreign_key="inv_import_batches.id")
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvManualValuation(SQLModel, table=True):
    """A unit value set by the owner (manual valuation mode, frozen instruments; 0 is valid)."""

    __tablename__ = "inv_manual_valuations"
    __table_args__ = (
        UniqueConstraint("profile_id", "instrument_id", "as_of", name="uq_inv_manual_valuation"),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_manual_valuations"))
    instrument_id: int = Field(foreign_key="inv_instruments.id", index=True)
    as_of: dt.date
    unit_value: Decimal = _decimal(nullable=False)
    currency: str
    note: str | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Strategy, rule runs, signals, journal
# --------------------------------------------------------------------------- #


class InvStrategyVersion(SQLModel, table=True):
    """A stored copy of the profile's strategy files, recorded whenever they change."""

    __tablename__ = "inv_strategy_versions"
    __table_args__ = (UniqueConstraint("profile_id", "version", name="uq_inv_strategy_version"),)

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_strategy_versions"))
    version: int  # 1, 2, ... per profile
    sha256: str  # of strategy.yaml + strategy.md
    yaml_text: str
    md_text: str | None = None
    state: str  # valid | partial | invalid
    issues: list[dict] = _json_list()  # [{severity, path, message, line, column}]
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvRuleRun(SQLModel, table=True):
    """One daily-check run for one profile."""

    __tablename__ = "inv_rule_runs"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_rule_runs"))
    trigger: str  # worker | api | cli
    as_of: dt.date
    status: str  # ok | partial | failed
    strategy_version_id: int | None = Field(default=None, foreign_key="inv_strategy_versions.id")
    stats: dict = _json_dict()
    errors: list[str] = _json_list()
    report: dict = _json_dict()  # {new: [signal ids], escalated: [signal ids]}
    started_at: dt.datetime = Field(default_factory=utcnow)
    finished_at: dt.datetime | None = None


class InvSignal(SQLModel, table=True):
    """A rule finding over time. At most one open (active / acknowledged) signal per dedup key."""

    __tablename__ = "inv_signals"
    __table_args__ = (
        Index(
            "uq_inv_signals_open_key",
            "profile_id",
            "dedup_key",
            unique=True,
            sqlite_where=text("status IN ('active', 'acknowledged')"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_signals"))
    rule_id: str
    kind: str
    dedup_key: str
    severity: str  # domain.SignalSeverity
    status: str  # domain.SignalStatus
    message: str
    instrument_id: int | None = Field(default=None, foreign_key="inv_instruments.id")
    account_id: int | None = Field(default=None, foreign_key="accounts.id")
    payload: dict = _json_dict()
    first_seen_at: dt.datetime = Field(default_factory=utcnow)
    last_seen_at: dt.datetime = Field(default_factory=utcnow)
    created_run_id: int | None = Field(default=None, foreign_key="inv_rule_runs.id")
    last_run_id: int | None = Field(default=None, foreign_key="inv_rule_runs.id")
    acknowledged_at: dt.datetime | None = None
    closed_at: dt.datetime | None = None  # resolved or expired


class InvNotification(SQLModel, table=True):
    """A signal due for an immediate notification; one per (signal, severity). ``sent_at`` is set by
    the worker that delivers it."""

    __tablename__ = "inv_notification_log"
    __table_args__ = (
        UniqueConstraint("signal_id", "severity", name="uq_inv_notification_signal_severity"),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_notification_log"))
    signal_id: int = Field(foreign_key="inv_signals.id")
    severity: str
    created_at: dt.datetime = Field(default_factory=utcnow)
    sent_at: dt.datetime | None = None
    channel: str | None = None


class InvDecision(SQLModel, table=True):
    """What the owner did about a signal (or on their own): the decision journal. Never books a trade."""

    __tablename__ = "inv_decisions"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_decisions"))
    signal_id: int | None = Field(default=None, foreign_key="inv_signals.id", index=True)
    instrument_id: int | None = Field(default=None, foreign_key="inv_instruments.id")
    account_id: int | None = Field(default=None, foreign_key="accounts.id")
    action: str  # domain.DecisionAction
    quantity: Decimal | None = _decimal()
    price: Decimal | None = _decimal()
    currency: str | None = None
    reason: str | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)


class InvThesis(SQLModel, table=True):
    """Why a position is held: entry type, thesis, what would invalidate it, exit and size plans."""

    __tablename__ = "inv_theses"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_theses"))
    instrument_id: int = Field(foreign_key="inv_instruments.id", index=True)
    entry_type: str  # sentiment_correction | trend | special_situation
    thesis: str
    invalidation: str | None = None
    exit_plan: str | None = None
    size_plan: str | None = None
    reviewed_at: dt.datetime | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


TABLES: tuple[type[SQLModel], ...] = (
    InvInstrument,
    InvInstrumentAlias,
    InvPriceBar,
    InvFxRate,
    InvAccountSettings,
    InvImportBatch,
    InvTransaction,
    InvPositionSnapshot,
    InvInstrumentRename,
    InvManualValuation,
    InvStrategyVersion,
    InvRuleRun,
    InvSignal,
    InvNotification,
    InvDecision,
    InvThesis,
)

THESIS_ENTRY_TYPES = ("sentiment_correction", "trend", "special_situation")
