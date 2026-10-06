"""Connector tables (migration 0016_connectors).

- ``connectors``: one row per installed connector (global, not per profile: it is code, not data). The
  manifest, the current ``content_sha256`` and resolved interpreter, and the owner's approval pinned as
  ``approved_sha256`` + ``approved_interpreter`` (+ the approved file list, for the "what changed" view).
  Status ``pending`` (never approved), ``approved``, ``changed`` (approved once, now different: does not
  run until approved again), ``disabled``.
- ``connector_bindings``: a fetch connector bound to one account of a profile: params, auto-commit
  choice, the opaque cursor and the polite-scheduling state. Secrets live in the OS keychain only.
- ``connector_runs``: one row per sandboxed run (outcome, error kind, counts, the redacted stderr tail).
  No foreign key on ``connector_id`` / ``binding_id``: ``finanse connectors test`` records runs of
  uninstalled directories, and the audit survives a deleted binding. The last 500 per connector are kept.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import JSON, Column, ForeignKey, Integer, UniqueConstraint
from sqlmodel import Field, SQLModel

from ..models import profile_fk_column, utcnow

CONNECTOR_STATUSES = ("pending", "approved", "changed", "disabled")
RUN_OUTCOMES = ("ok", "failed", "timeout", "refused")
SOURCES = ("cli", "mcp")


class Connector(SQLModel, table=True):
    __tablename__ = "connectors"

    id: str = Field(primary_key=True)  # the manifest id
    name: str
    version: str
    module: str  # investments | budget
    kind: str  # file | fetch
    manifest_json: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    content_sha256: str
    interpreter_path: str
    status: str = Field(default="pending")
    approved_sha256: str | None = None
    approved_interpreter: str | None = None
    approved_files_json: list[Any] | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    approved_at: dt.datetime | None = None
    installed_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)
    source: str = Field(default="cli")  # cli | mcp


class ConnectorBinding(SQLModel, table=True):
    __tablename__ = "connector_bindings"
    __table_args__ = (
        UniqueConstraint("account_id", "connector_id", name="uq_connector_binding_account"),
    )

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("connector_bindings"))
    account_id: int = Field(foreign_key="accounts.id", index=True)
    connector_id: str = Field(foreign_key="connectors.id", index=True)
    params_json: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    auto_commit: bool = Field(default=False)
    cursor: str | None = None
    last_run_at: dt.datetime | None = None
    last_status: str | None = None  # the last run's outcome (ok | failed | timeout | refused)
    last_ok_at: dt.datetime | None = None
    backoff_until: dt.datetime | None = None
    created_at: dt.datetime = Field(default_factory=utcnow)
    updated_at: dt.datetime = Field(default_factory=utcnow)


class ConnectorRun(SQLModel, table=True):
    __tablename__ = "connector_runs"

    id: int | None = Field(default=None, primary_key=True)
    connector_id: str = Field(index=True)
    profile_id: int | None = Field(
        default=None,
        sa_column=Column(
            "profile_id",
            Integer,
            ForeignKey("profiles.id", name="fk_connector_runs_profile_id"),
            nullable=True,
            index=True,
        ),
    )
    binding_id: int | None = None
    command: str  # detect | convert | fetch | check
    started_at: dt.datetime = Field(default_factory=utcnow)
    duration_ms: int = Field(default=0)
    outcome: str  # ok | failed | timeout | refused
    error_kind: str | None = None
    exit_code: int | None = None
    records: int = Field(default=0)
    bytes_in: int = Field(default=0)  # network bytes received through the egress proxy
    bytes_out: int = Field(default=0)  # network bytes sent through the egress proxy
    denied_hosts_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    stderr_tail: str | None = None  # last 4 KiB, scrubbed; shown to the owner only
    proposal_id: int | None = None
    batch_ref: str | None = None


TABLES: tuple[type[SQLModel], ...] = (Connector, ConnectorBinding, ConnectorRun)
