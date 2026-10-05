"""Investments tables (prefixed ``inv_``: the budget module already owns ``transactions``).

Shared reference data (every profile sees the same rows): instruments, their aliases, daily price bars
and FX rates. Everything else belongs to one profile, through its brokerage account (transactions,
broker position snapshots, account settings) or a ``profile_id`` (renames, manual valuations, strategy
versions, rule runs, signals, notifications, decisions, theses, import batches, the profile's overrides
of shared instruments, alerts, watchlist items, planned deposits, research runs and notes).

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
    # Added by 0007 (ALTER TABLE ADD COLUMN appends it, so it stays the last column): positive |
    # negative | neutral (``rules.SignalPolarity``), from the rule / kind default or the alert.
    polarity: str = Field(default="neutral", sa_column_kwargs={"server_default": "neutral"})
    # Added by 0007: "Odłóż do" - hidden from the attention list and not notified until then.
    snoozed_until: dt.datetime | None = None


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


# --------------------------------------------------------------------------- #
# Profile overrides of shared instruments, alerts, the watchlist (F5)
# --------------------------------------------------------------------------- #


class InvProfileInstrument(SQLModel, table=True):
    """One profile's own view of a shared instrument: the owner-editable attributes it changed
    (classification, display name, valuation mode, status incl. frozen / delisted, reviewed flag).
    ``None`` = the shared default on ``inv_instruments``; an empty text clears a text attribute for
    this profile. Market identity (symbol, ISIN, currency, MIC, price aliases) stays shared."""

    __tablename__ = "inv_profile_instruments"
    __table_args__ = (
        UniqueConstraint("profile_id", "instrument_id", name="uq_inv_profile_instrument"),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_profile_instruments"))
    instrument_id: int = Field(foreign_key="inv_instruments.id", index=True)
    name: str | None = None
    asset_class: str | None = None
    tags: list[str] | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    region: str | None = None
    sector: str | None = None
    valuation_mode: str | None = None
    status: str | None = None
    needs_classification: bool | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


class InvAlert(SQLModel, table=True):
    """A condition on hard market or portfolio data from a fixed catalog (``alerts.catalog``), set by
    the owner or an agent. Evaluated in the daily check; a triggered alert becomes a signal
    (``rule_id = dedup_key = "alert:<id>"``, ``kind = "alert:<kind>"``). Never a price prediction."""

    __tablename__ = "alerts"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("alerts"))
    instrument_id: int | None = Field(default=None, foreign_key="inv_instruments.id", index=True)
    scope: str  # instrument | portfolio | bucket
    kind: str  # alerts.catalog kind (price_above, change_pct, ..., custom)
    params: dict = _json_dict()  # normalized params of the kind
    polarity: str = Field(default="neutral")  # positive | negative | neutral
    severity: str = Field(default="info")  # info | action
    title: str
    note: str | None = None
    source: str = Field(default="user")  # user | agent
    created_by: str = Field(default="app")  # app | cli | mcp
    status: str = Field(default="active")  # active | triggered | snoozed | muted | expired
    cooldown_days: int | None = None
    expires_at: dt.datetime | None = None
    snoozed_until: dt.datetime | None = None
    last_triggered_at: dt.datetime | None = None
    last_checked_at: dt.datetime | None = None
    last_value: str | None = None  # measured value at the last check (decimal text)
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)
    # Added by 0008 (ALTER TABLE ADD COLUMN appends it, so it stays the last column): soft delete.
    # A deleted alert is never listed or evaluated; `POST alerts/{id}/restore` brings it back with the
    # same id within ``service.alerts.RESTORE_WINDOW`` of the deletion. The row is never purged, so
    # its id is never handed to a new alert.
    deleted_at: dt.datetime | None = None


class InvWatchlistItem(SQLModel, table=True):
    """An instrument the profile watches without (necessarily) holding it; joins the daily price
    refresh and can carry alerts."""

    __tablename__ = "watchlist_items"
    __table_args__ = (
        UniqueConstraint("profile_id", "instrument_id", name="uq_watchlist_profile_instrument"),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("watchlist_items"))
    instrument_id: int = Field(foreign_key="inv_instruments.id", index=True)
    note: str | None = None
    tags: list[str] = _json_list()
    source: str = Field(default="user")  # user | agent
    added_at: dt.datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Planned deposits, the research layer (F6)
# --------------------------------------------------------------------------- #


class InvPlannedDeposit(SQLModel, table=True):
    """A deposit the owner plans to make ("Zaplanuj wpłatę"). Counted against the contribution plan,
    never as cash or value until booked: an imported deposit that matches it (``service.planned``)
    books it (``status`` booked, ``booked_txn_id`` = that transaction)."""

    __tablename__ = "inv_planned_deposits"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("inv_planned_deposits"))
    account_id: int | None = Field(default=None, foreign_key="accounts.id", index=True)
    amount: Decimal = _decimal(nullable=False)  # > 0, in ``currency``
    currency: str
    planned_date: dt.date
    note: str | None = None
    status: str = Field(default="planned")  # PLANNED_DEPOSIT_STATUSES
    booked_txn_id: int | None = Field(default=None, foreign_key="inv_transactions.id")
    booked_at: dt.datetime | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


class InvResearchRun(SQLModel, table=True):
    """One research pass by the agent (the Saturday routine or on demand): what it covered (``scope``)
    and what it produced (``counts``). Written through MCP (``start_research_run`` /
    ``finish_research_run``)."""

    __tablename__ = "research_runs"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("research_runs"))
    started_at: dt.datetime = Field(default_factory=utcnow)
    finished_at: dt.datetime | None = None
    status: str = Field(default="running")  # RESEARCH_RUN_STATUSES
    scope: dict = _json_dict()
    counts: dict = _json_dict()
    created_by: str = Field(default="agent")  # RESEARCH_CREATORS


class InvResearchNote(SQLModel, table=True):
    """A sourced fact or sentiment reading about a held, watched or candidate instrument, or a sector /
    macro theme. Facts and sentiment only: no recommendation, no price prediction, no amounts.

    ``details`` carries structured data of candidate notes (criteria met / unmet vs the strategy's
    thresholds, entry type); ``thesis_field`` names the thesis field the note bears on. Dismissal sets
    ``dismissed_at`` (a restore within ``RESEARCH_RESTORE_MINUTES`` clears it); a dismissed candidate
    gets ``cooldown_until`` = dismissal + ``RESEARCH_CANDIDATE_COOLDOWN_DAYS`` and is not re-proposed
    before then (matched by ``instrument_id`` or ``candidate_key``). ``signal_id`` is the research
    signal the note created or joined (dismissing the note resolves it)."""

    __tablename__ = "research_notes"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("research_notes"))
    run_id: int | None = Field(default=None, foreign_key="research_runs.id", index=True)
    instrument_id: int | None = Field(default=None, foreign_key="inv_instruments.id", index=True)
    theme: str | None = None  # sector or macro topic
    kind: str  # RESEARCH_NOTE_KINDS
    polarity: str = Field(default="neutral")  # RESEARCH_POLARITIES
    strength: int = Field(default=1)  # 1-3
    thesis_relation: str = Field(default="none")  # RESEARCH_THESIS_RELATIONS
    thesis_field: str | None = None  # RESEARCH_THESIS_FIELDS
    title: str  # <= RESEARCH_TITLE_MAX
    summary: str  # Polish, <= RESEARCH_SUMMARY_MAX
    sources: list[dict] = _json_list()  # [{title, url, publisher, published_at}], at least one
    details: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    candidate_key: str | None = Field(default=None, index=True)  # upper-case ISIN or symbol
    signal_id: int | None = Field(default=None, foreign_key="inv_signals.id")
    observed_at: dt.datetime = Field(default_factory=utcnow)
    expires_at: dt.datetime  # default observed_at + RESEARCH_NOTE_TTL_DAYS (set by the service)
    created_by: str = Field(default="agent")  # RESEARCH_CREATORS
    dismissed_at: dt.datetime | None = None
    cooldown_until: dt.datetime | None = None
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
    InvProfileInstrument,
    InvAlert,
    InvWatchlistItem,
    InvPlannedDeposit,
    InvResearchRun,
    InvResearchNote,
)

THESIS_ENTRY_TYPES = ("sentiment_correction", "trend", "special_situation")

PLANNED_DEPOSIT_STATUSES = ("planned", "booked", "cancelled")

# Research layer contract (F6-wave.md "Research layer"); validation lives in the research service.
RESEARCH_RUN_STATUSES = ("running", "done", "failed")
RESEARCH_NOTE_KINDS = ("news", "earnings", "community", "trend", "macro", "candidate")
RESEARCH_POLARITIES = ("positive", "negative", "neutral")
RESEARCH_THESIS_RELATIONS = ("supports", "weakens", "invalidates", "neutral", "none")
RESEARCH_THESIS_FIELDS = ("entry_type", "thesis", "invalidation", "exit_plan", "size_plan")
RESEARCH_CREATORS = ("agent", "user")
RESEARCH_TITLE_MAX = 120
RESEARCH_SUMMARY_MAX = 1200
RESEARCH_NOTE_TTL_DAYS = 30
RESEARCH_RESTORE_MINUTES = 15
RESEARCH_CANDIDATE_COOLDOWN_DAYS = 90
