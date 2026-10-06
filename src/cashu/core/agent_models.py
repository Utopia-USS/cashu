"""Tables of the agent layer (MCP): proposals, the MCP call audit log and weekly review records.

- ``proposals``: changes an agent suggested through MCP (a strategy, a custom rule, an import). They do
  nothing until the owner approves them in the app (``core.proposals``).
- ``mcp_calls``: one row per MCP tool call (tool, privacy level, time, outcome). Argument *names* and
  JSON types only, never their values (``core.mcp.audit``).
- ``reviews``: a weekly review marked done for a module (``core.reviews``), from the app or MCP.

All three belong to one profile (``profile_id``).
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel

from .models import profile_fk_column, utcnow

# ``applying``: an approval is applying it right now (core.proposals; under the approval lock).
PROPOSAL_STATUSES = ("pending", "applying", "approved", "rejected", "failed")


def _json_dict() -> Any:
    return Field(default_factory=dict, sa_column=Column(JSON, nullable=False))


class Proposal(SQLModel, table=True):
    """A change suggested by an agent, waiting for the owner's decision in the app."""

    __tablename__ = "proposals"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("proposals"))
    kind: str  # strategy | custom_rule | import (core.proposals kinds)
    status: str = Field(default="pending")  # pending | applying | approved | rejected | failed
    summary: str = Field(default="")  # one line for lists
    reason: str | None = None  # why the agent proposes it (agent text)
    payload: dict = _json_dict()  # kind-specific (validated when created)
    result: dict = _json_dict()  # what approving did (version, batch id) or why it failed
    source: str = Field(default="mcp")
    created_at: dt.datetime = Field(default_factory=utcnow)
    reviewed_at: dt.datetime | None = None


class McpCall(SQLModel, table=True):
    """Audit row of one MCP tool call. ``args`` maps argument names to JSON types, never values."""

    __tablename__ = "mcp_calls"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("mcp_calls"))
    tool: str
    privacy: str  # strict | amounts (the level the call was answered under)
    called_at: dt.datetime = Field(default_factory=utcnow)
    args: dict = _json_dict()
    outcome: str = Field(default="ok")  # ok | error | refused
    error_kind: str | None = None  # a fixed code, never a message with data
    duration_ms: int = Field(default=0)


class Review(SQLModel, table=True):
    """A weekly review of a module marked done (``stats``: counts at that moment)."""

    __tablename__ = "reviews"

    id: int | None = Field(default=None, primary_key=True)
    profile_id: int = Field(sa_column=profile_fk_column("reviews"))
    module: str
    done_at: dt.datetime = Field(default_factory=utcnow)
    notes: str | None = None
    stats: dict = _json_dict()


TABLES: tuple[type[SQLModel], ...] = (Proposal, McpCall, Review)
