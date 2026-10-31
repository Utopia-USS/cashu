"""Tables of the sync outbox (S30, the strangler bridge): ``sync_outbox``, ``sync_ids``, ``sync_vaults``.

TRANSITIONAL(S49): these tables exist only while the Python app writes the data and the TS store
(event log) reads it; they go with the Python write path.

- ``sync_outbox``: one row per captured change of a synced table (``core/sync_outbox.py``), written in
  the same transaction as the change, so a rollback leaves none. The shipper (S31a) reads it in id
  order, turns rows into catalog events and acks them; a row is deleted only after its ack.
- ``sync_ids``: the gid of a local row per vault (profile). Python-minted ULIDs, DET gids Python could
  compute, genesis ids (S26 ``ids.jsonl``) and gids the shipper returns with an ack.
- ``sync_vaults``: which vault (32 lower-case hex, S27 vault id) a profile is. Not secret; the gid salt
  is never stored here (it lives in the OS keychain, ``core/sync_keys.py``).

No foreign keys: an outbox row never blocks a profile or row delete.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import JSON, Column, Index, UniqueConstraint
from sqlmodel import Field, SQLModel

from .models import utcnow


class SyncOutbox(SQLModel, table=True):
    """One captured change: ``op`` is ``insert`` / ``update`` / ``delete`` (generic capture) or an
    explicit semantic op (``merge``, ``undo``, ``leg_delete``). ``fields``: the synced columns'
    values as stored in SQLite (insert: all, update: the changed ones, delete: the last state);
    ``prev``: an update's previous values; ``key``: the DET gid parts in local form (columns and
    referenced local ids) so the shipper can compute a gid Python left NULL."""

    __tablename__ = "sync_outbox"
    __table_args__ = (Index("ix_sync_outbox_row", "table_name", "local_id"),)

    id: int | None = Field(default=None, primary_key=True)
    ts: dt.datetime = Field(default_factory=utcnow)
    txn: str  # one token per database transaction: the shipper's batch boundary
    profile_id: int | None = Field(default=None, index=True)  # None = shared (instruments, aliases)
    table_name: str
    op: str
    local_id: str  # the primary key as text; a composite key joined by "|"
    gid: str | None = None
    fields: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    prev: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    key: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    origin: str = Field(default="local")  # local | inbound (S31b applies; never shipped back)
    acked_at: dt.datetime | None = Field(default=None, index=True)


class SyncId(SQLModel, table=True):
    """Local row -> gid in one vault. Global tables (instruments, aliases) have one entry per vault."""

    __tablename__ = "sync_ids"
    __table_args__ = (UniqueConstraint("profile_id", "table_name", "gid", name="uq_sync_ids_gid"),)

    profile_id: int = Field(primary_key=True)
    table_name: str = Field(primary_key=True)
    local_id: str = Field(primary_key=True)
    gid: str
    source: str  # minted | det | genesis | shipper


class SyncVault(SQLModel, table=True):
    """The vault id of a profile (set by ``cashu sync link`` when the vault exists, S31a / S48)."""

    __tablename__ = "sync_vaults"

    profile_id: int = Field(primary_key=True)
    vault_id: str = Field(unique=True)
    linked_at: dt.datetime = Field(default_factory=utcnow)
