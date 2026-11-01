"""Inbound applier (S31b): edits made on other devices (the phone) applied to this database.

TRANSITIONAL(S49): the strangler bridge in the other direction from ``core/sync_outbox.py``. The local
sync daemon decrypts the vault's events (crypto stays TS-only) and pipes the plaintext logical
envelopes (``packages/store/spec/events.md`` 2) as JSON lines to ``cashu sync apply --stdin``.

Rules (events.md 2, 6, 7; gid.md 4):

- **Allow-list.** Only the types in :data:`HANDLERS` are applied, each through the existing service
  (budget ``set_transaction_category`` / ``recategorize_merchant``, ``categorize.rules.upsert_rule``,
  ``service.alerts.update`` / ``mute``, ``store.signals.snooze``, ``store.journal.record_decision``
  (it acknowledges the linked signals), ``core.reviews.mark_done``, research ``mark_read`` /
  ``dismiss``). Any other type is rejected and logged with its type and a reason code, never a value.
- **One vault per run.** The run is bound to one profile; an event of another vault (``vault`` is not
  the profile's ``sync_vaults`` entry) or of an unlinked profile is rejected.
- **Gids.** Entities are resolved through ``sync_ids`` of that profile. An unknown gid parks the event
  (``sync_inbound`` keeps its body) and every later run retries it. A ``categoryRule.set`` must carry
  ``DET(category_rules)[merchantKey]`` with the vault salt (gid.md 4, invalid-gid): a mismatch is
  rejected, a missing salt parks.
- **Idempotent by eid.** ``sync_inbound`` records every settled event in the same transaction as its
  writes: a second delivery is a no-op; an ``eid`` reused with another body is rejected (events.md 2).
- **No echo.** The writes run inside :func:`sync_outbox.inbound`: the outbox records them already
  acked with ``origin = inbound``, so the shipper never sends them back; rows the event creates take
  the event's gid. A later local edit of the same row is captured normally.
- **LWW-F by HLC.** Per synced field, an inbound write applies only if it sorts after the field's last
  write, in the ``(hlc, eid)`` order of events.md 3.2: ``sync_clock`` holds the last write whose stamp
  this database knows (inbound writes, and local writes the shipper acked with their field clocks,
  S31a P-A); a local write still in the outbox (unacked) sorts after every event the daemon has already
  received (its HLC is stamped later, events.md 3.3 receive rule); an acked one without clocks (an older
  shipper, the first-start cut) at least at its own wall time (``hlc_floor``, conservative: its real
  stamp is never lower).
  GUARDs are kept: a locked manual rule / manual claim is not overwritten by a later LLM write, so
  later local LLM writes do not count against an inbound manual one.

Requires ``CASHU_SYNC=1``: without capture a local edit leaves no trace, and an older inbound edit
could overwrite it.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import delete, insert, or_
from sqlmodel import Session, select

from . import sync_keys, sync_outbox
from .models import Profile, utcnow
from .sync_models import SyncClock, SyncId, SyncInbound, SyncOutbox, SyncVault

log = logging.getLogger(__name__)

STATUSES = ("applied", "duplicate", "lost", "covered", "parked", "rejected")
"""Outcome of one event. Persisted: all but ``duplicate`` (and rejections that are about the run, not
the event: a bad envelope, an unlinked vault, another profile's vault)."""

ULID_RE = sync_outbox.ULID_RE
UUID8_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")
HLC_RE = sync_outbox.HLC_RE  # events.md 3.1; one definition shared with the ack clocks
TYPE_RE = re.compile(r"^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$")
TIMESTAMP_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$")
DECIMAL_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
MODULE_RE = KEY_RE
ASSET_CURRENCY_RE = re.compile(r"^[A-Z0-9]{2,10}$")

TXN_CLAIM_SOURCES = ("manual_txn", "llm_full", "llm_fallback")
RULE_SOURCES = ("manual", "llm")
ALERT_OWNER_STATUSES = ("active", "muted", "snoozed")
DECISION_ACTIONS = ("bought", "sold", "held", "ignored", "other")
COVERED_CLOSE_REASONS = frozenset({"mute", "snooze", "note_dismissed"})
"""``signal.closed`` reasons that ride with an allowed owner action in one batch (events.md 6.5, 8.9):
the Python service of that sibling closes the signal itself, so the close is ``covered``."""


class SyncApplyError(RuntimeError):
    """The applier cannot run (capture off, no profile)."""


class _Reject(Exception):
    def __init__(self, reason: str, *, persist: bool = True) -> None:
        super().__init__(reason)
        self.reason = reason
        self.persist = persist


class _Park(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class _Refused(Exception):
    """A service refused the change (its domain error): the event's writes are rolled back."""


@dataclass(frozen=True)
class Outcome:
    status: str
    reason: str | None = None


# --------------------------------------------------------------------------- #
# Envelope
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Event:
    eid: str
    vault: str
    device: str
    hlc: str
    at: dt.datetime
    type: str
    v: int
    gid: str
    data: dict
    cause: str | None
    raw: dict
    digest: str

    @property
    def order(self) -> tuple[str, str]:
        return (self.hlc, self.eid)


def _digest(raw: dict) -> str:
    text = json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_timestamp(value: Any) -> dt.datetime | None:
    """An events.md 4.3 UTC timestamp as an aware datetime; None when it is not one."""
    if not isinstance(value, str):
        return None
    m = TIMESTAMP_RE.match(value)
    if m is None:
        return None
    frac = (m.group(7) or ".")[1:].ljust(6, "0")
    try:
        return dt.datetime(
            *(int(m.group(i)) for i in range(1, 7)), int(frac or 0), tzinfo=dt.UTC
        )
    except ValueError:
        return None


def _is_gid(value: Any) -> bool:
    return isinstance(value, str) and bool(ULID_RE.match(value) or UUID8_RE.match(value))


def parse_event(raw: Any) -> Event:
    """Validate a logical envelope (events.md 2). Raises ``_Reject('bad-envelope')``."""
    bad = _Reject("bad-envelope", persist=False)
    if not isinstance(raw, dict):
        raise bad
    eid, vault, device, hlc = raw.get("eid"), raw.get("vault"), raw.get("device"), raw.get("hlc")
    at, typ, v, gid, data = raw.get("at"), raw.get("type"), raw.get("v"), raw.get("gid"), raw.get("data")
    cause = raw.get("cause")
    if not (isinstance(eid, str) and ULID_RE.match(eid)):
        raise bad
    if not (isinstance(vault, str) and HEX32_RE.match(vault)):
        raise bad
    if not (isinstance(device, str) and HEX32_RE.match(device) and device.strip("0")):
        raise bad
    if not (isinstance(hlc, str) and HLC_RE.match(hlc) and hlc[15:] == device):
        raise bad
    when = parse_timestamp(at)
    if when is None or not (isinstance(typ, str) and TYPE_RE.match(typ)):
        raise bad
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise bad
    if not (_is_gid(gid) or (isinstance(gid, str) and HEX32_RE.match(gid))):
        raise bad
    if not isinstance(data, dict):
        raise bad
    if cause is not None and not (isinstance(cause, str) and ULID_RE.match(cause)):
        raise bad
    return Event(eid, vault, device, hlc, when, typ, v, gid, data, cause, raw, _digest(raw))


def safe_type(raw: Any) -> str:
    """The event type for a log line: only a well-formed type name, else a placeholder."""
    typ = raw.get("type") if isinstance(raw, dict) else None
    return typ if isinstance(typ, str) and len(typ) <= 64 and TYPE_RE.match(typ) else "<invalid>"


# --------------------------------------------------------------------------- #
# HLC helpers
# --------------------------------------------------------------------------- #

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int, width: int) -> str:
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return out.rjust(width, "0")


def hlc_floor(when: dt.datetime) -> tuple[str, str]:
    """The lowest ``(hlc, eid)`` a write made at ``when`` can be stamped with (events.md 3.3: an HLC
    wall is never behind the physical clock of the stamping device)."""
    aware = when if when.tzinfo is not None else when.replace(tzinfo=dt.UTC)
    ms = int(aware.timestamp() * 1000)
    return (f"{_base36(ms, 9)}-0000-{'0' * 32}", "")


# --------------------------------------------------------------------------- #
# Context of one event
# --------------------------------------------------------------------------- #

Evidence = Callable[[dict, dict | None], bool]
"""``(fields, prev)`` of a local outbox row -> True when it counts as a competing write."""


@dataclass
class _Ctx:
    s: Session
    ev: Event
    pid: int

    @property
    def profile(self) -> Profile:
        p = self.s.get(Profile, self.pid)
        if p is None:
            raise _Reject("profile-mismatch", persist=False)
        return p

    def local(self, table: str, gid: str | None = None) -> str | None:
        return self.s.exec(
            select(SyncId.local_id).where(
                SyncId.profile_id == self.pid,
                SyncId.table_name == table,
                SyncId.gid == (gid or self.ev.gid),
            )
        ).first()

    def need(self, table: str, gid: str | None = None) -> int:
        """The local id of a referenced gid; parks the event when it is not known (yet)."""
        local = self.local(table, gid)
        if local is None:
            raise _Park("unknown-gid")
        try:
            return int(local)
        except ValueError:
            raise _Park("unknown-gid") from None

    def map(self, table: str, local_id: int, gid: str | None = None) -> None:
        """The row this event created (or first named) is the event's gid in this vault."""
        gid = gid or self.ev.gid
        conn = self.s.connection()
        ids = SyncId.__table__
        conn.execute(
            delete(ids).where(
                ids.c.profile_id == self.pid,
                ids.c.table_name == table,
                or_(ids.c.local_id == str(local_id), ids.c.gid == gid),
            )
        )
        conn.execute(
            insert(ids).values(
                profile_id=self.pid, table_name=table, local_id=str(local_id), gid=gid, source="inbound"
            )
        )

    def winners(
        self, table: str, local_id: int, cols: Iterable[str], evidence: Evidence | None = None
    ) -> list[str]:
        """The columns this event wins (LWW-F, module docstring)."""
        cols = list(cols)
        clocks = {
            c.field: (c.hlc, c.eid)
            for c in self.s.exec(
                select(SyncClock).where(
                    SyncClock.profile_id == self.pid,
                    SyncClock.table_name == table,
                    SyncClock.local_id == str(local_id),
                    SyncClock.field.in_(cols),
                )
            ).all()
        }
        rows = self.s.exec(
            select(SyncOutbox.fields, SyncOutbox.prev, SyncOutbox.ts, SyncOutbox.acked_at).where(
                SyncOutbox.table_name == table,
                SyncOutbox.local_id == str(local_id),
                SyncOutbox.origin == "local",
                SyncOutbox.profile_id == self.pid,
            )
        ).all()
        out = []
        for col in cols:
            if col in clocks and clocks[col] >= self.ev.order:
                continue
            newer_local = False
            for fields, prev, ts, acked_at in rows:
                if col not in (fields or {}) or (evidence and not evidence(fields, prev)):
                    continue
                if acked_at is None or hlc_floor(ts) > self.ev.order:
                    newer_local = True
                    break
            if not newer_local:
                out.append(col)
        return out

    def stamp(self, table: str, local_id: int, cols: Iterable[str]) -> None:
        """Record this event as the last write of ``cols`` (only moves forward)."""
        for col in cols:
            key = (self.pid, table, str(local_id), col)
            row = self.s.get(SyncClock, key)
            if row is None:
                self.s.add(
                    SyncClock(
                        profile_id=self.pid,
                        table_name=table,
                        local_id=str(local_id),
                        field=col,
                        hlc=self.ev.hlc,
                        eid=self.ev.eid,
                    )
                )
            elif (row.hlc, row.eid) < self.ev.order:
                row.hlc, row.eid = self.ev.hlc, self.ev.eid
                self.s.add(row)

    @contextmanager
    def inbound(self, bind: dict[str, str] | None = None) -> Iterator[None]:
        """Run service writes as inbound (no echo; created rows take ``bind`` gids) and flush inside,
        so the outbox capture sees them while the origin is ``inbound``."""
        with sync_outbox.inbound(self.s, bind=bind):
            yield
            self.s.flush()

    def time(self, col: str | None = None, explicit: dt.datetime | None = None) -> dt.datetime:
        """Domain time (events.md 4.4): ``data.stamps[col]``, else the explicit field, else ``at``."""
        stamps = self.ev.data.get("stamps")
        if col and isinstance(stamps, dict):
            stamped = parse_timestamp(stamps.get(col))
            if stamped is not None:
                return stamped
        return explicit or self.ev.at


# --------------------------------------------------------------------------- #
# Payload checks
# --------------------------------------------------------------------------- #


def _bad() -> _Reject:
    return _Reject("bad-payload")


def _opt_ts(data: dict, key: str, *, required: bool = False) -> dt.datetime | None:
    if key not in data:
        if required:
            raise _bad()
        return None
    value = data[key]
    if value is None:
        return None
    parsed = parse_timestamp(value)
    if parsed is None:
        raise _bad()
    return parsed


def _opt_str(data: dict, key: str, *, nonempty: bool = False) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or (nonempty and not value):
        raise _bad()
    return value


def _opt_decimal(data: dict, key: str) -> Decimal | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not DECIMAL_RE.match(value):
        raise _bad()
    try:
        return Decimal(value)
    except InvalidOperation:
        raise _bad() from None


def _service_errors() -> tuple[type[BaseException], ...]:
    from cashu.core.reviews import ReviewError
    from cashu.modules.investments.research.service import ResearchError
    from cashu.modules.investments.service.alerts import AlertError
    from cashu.modules.investments.store.journal import JournalError

    return (AlertError, JournalError, ReviewError, ResearchError)


def _not_found_errors() -> tuple[type[BaseException], ...]:
    from cashu.modules.investments.research.service import ResearchNotFound
    from cashu.modules.investments.service.alerts import AlertNotFound

    return (AlertNotFound, ResearchNotFound)


# --------------------------------------------------------------------------- #
# Handlers (the allow-list)
# --------------------------------------------------------------------------- #

GONE = Outcome("lost", "gone")
"""The gid is mapped but the row is no longer the profile's (deleted): a no-op, as on a tombstone."""


def _txn_category_set(ctx: _Ctx) -> Outcome:
    """``txn.categorySet`` (manual claim, events.md 8.3) -> ``budget.service.set_transaction_category``."""
    from cashu.modules.budget import service as budget

    data = ctx.ev.data
    category, source = data.get("category"), data.get("source")
    if not (isinstance(category, str) and KEY_RE.match(category)) or source not in TXN_CLAIM_SOURCES:
        raise _bad()
    if source != "manual_txn":
        raise _Reject("unsupported-source")  # LLM claims are made by the device running the LLM
    tid = ctx.need("transactions")

    def counts(fields: dict, prev: dict | None) -> bool:
        # GUARD: a later LLM claim is a no-op against this manual one; a manual claim or a clear counts
        return fields.get("category_source") not in ("llm_full", "llm_fallback")

    cols = ("category", "category_source")
    if len(ctx.winners("transactions", tid, cols, counts)) < len(cols):
        return Outcome("lost", "older")
    with ctx.inbound():
        found = budget.set_transaction_category(ctx.s, tid, category, profile_id=ctx.pid)
    if not found:
        return GONE
    ctx.stamp("transactions", tid, cols)
    return Outcome("applied")


def _category_rule_set(ctx: _Ctx) -> Outcome:
    """``categoryRule.set`` -> ``recategorize_merchant`` for a locked manual pin (the phone's merchant
    fix: the rule plus its re-application to rows, which is derived), else ``upsert_rule``."""
    from cashu.modules.budget import service as budget
    from cashu.modules.budget.categorize.rules import upsert_rule
    from cashu.modules.budget.models import CategoryRule

    data = ctx.ev.data
    merchant, category = data.get("merchantKey"), data.get("category")
    source, locked = data.get("source"), data.get("locked")
    if not (isinstance(merchant, str) and merchant) or not (isinstance(category, str) and KEY_RE.match(category)):
        raise _bad()
    if source not in RULE_SOURCES or not isinstance(locked, bool):
        raise _bad()
    vault = ctx.ev.vault
    salt = sync_keys.gid_salt(vault)
    if salt is None:
        raise _Park("no-salt")
    if sync_keys.det_gid(salt, "category_rules", [merchant]) != ctx.ev.gid:
        raise _Reject("invalid-gid")
    local = ctx.local("category_rules")
    rule = ctx.s.get(CategoryRule, int(local)) if local is not None else None
    if rule is not None and (rule.profile_id != ctx.pid or rule.merchant_key != merchant):
        rule = None
    if rule is None:
        rule = ctx.s.exec(
            select(CategoryRule).where(
                CategoryRule.profile_id == ctx.pid, CategoryRule.merchant_key == merchant
            )
        ).first()
    cols = ("category", "source", "locked")
    if rule is not None:
        if rule.locked and source != "manual":
            return Outcome("lost", "guard")  # GUARD: an LLM rule never replaces a locked one

        current_source = rule.source

        def counts(fields: dict, prev: dict | None) -> bool:
            # an inbound lock is not overwritten by a later local LLM write (its GUARD no-op); a write
            # that left the source alone kept the rule's source
            return not (locked and fields.get("source", current_source) != "manual")

        if len(ctx.winners("category_rules", rule.id, cols, counts)) < len(cols):
            return Outcome("lost", "older")
    with ctx.inbound(bind={"category_rules": ctx.ev.gid}):
        if source == "manual" and locked:
            budget.recategorize_merchant(ctx.s, merchant, category, profile_id=ctx.pid)
        else:
            upsert_rule(ctx.s, merchant, category, source=source, locked=locked, profile_id=ctx.pid)
    rule = ctx.s.exec(
        select(CategoryRule).where(CategoryRule.profile_id == ctx.pid, CategoryRule.merchant_key == merchant)
    ).one()
    ctx.map("category_rules", rule.id)
    ctx.stamp("category_rules", rule.id, cols)
    return Outcome("applied")


def _int_or_none(value: Any) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


_ALERT_PATCH: dict[str, tuple[str, Callable[[Any], bool]]] = {
    "title": ("title", lambda v: isinstance(v, str) and bool(v)),
    "note": ("note", lambda v: v is None or isinstance(v, str)),
    "params": ("params", lambda v: isinstance(v, dict)),
    "polarity": ("polarity", lambda v: isinstance(v, str) and bool(KEY_RE.match(v))),
    "severity": ("severity", lambda v: isinstance(v, str) and bool(KEY_RE.match(v))),
    "cooldownDays": ("cooldown_days", _int_or_none),
}
"""``alert.updated`` payload key -> (``service.alerts.update`` key, check); ``expiresAt`` is parsed."""


def _alert(
    ctx: _Ctx,
    changes: dict,
    cols: Iterable[str],
    evidence: Evidence | None = None,
    *,
    whole: bool = False,
) -> Outcome:
    """``whole``: the columns are one register (status + snoozed_until move together)."""
    from cashu.modules.investments.service import alerts

    cols = list(cols)
    aid = ctx.need("alerts")
    won = ctx.winners("alerts", aid, cols, evidence)
    if not won or (whole and len(won) < len(cols)):
        return Outcome("lost", "older")
    patch = {k: v for k, v in changes.items() if k in won}
    try:
        with ctx.inbound():
            if patch == {"status": "muted"}:
                alerts.mute(ctx.s, ctx.profile, aid, now=ctx.time())
            else:
                alerts.update(ctx.s, ctx.profile, aid, patch, now=ctx.time())
    except _not_found_errors():
        return GONE
    ctx.stamp("alerts", aid, won)
    return Outcome("applied")


def _alert_updated(ctx: _Ctx) -> Outcome:
    """``alert.updated`` (LWW-F patch of the config) -> ``service.alerts.update``, winning fields only."""
    data = ctx.ev.data
    changes: dict[str, Any] = {}
    for key, (col, ok) in _ALERT_PATCH.items():
        if key in data:
            if not ok(data[key]):
                raise _bad()
            changes[col] = data[key]
    if "expiresAt" in data:
        changes["expires_at"] = _opt_ts(data, "expiresAt")
    if not changes:
        raise _bad()
    return _alert(ctx, changes, changes)


def _alert_owner_write(fields: dict, prev: dict | None) -> bool:
    """A local status write that competes with ``alert.statusSet``: the owner's mute / snooze / re-arm,
    not the daily check's triggered / active / expired (a separate register in the view, events.md 8.7)."""
    if "status" not in fields:
        return True  # snoozed_until alone: a new snooze time
    new, old = fields["status"], (prev or {}).get("status")
    return new in ("muted", "snoozed") or (new == "active" and old in ("muted", "snoozed"))


def _alert_status_set(ctx: _Ctx) -> Outcome:
    """``alert.statusSet`` -> ``service.alerts.mute`` / ``update`` (its open signal closes with it)."""
    data = ctx.ev.data
    status = data.get("status")
    until = _opt_ts(data, "snoozedUntil", required=True)
    if status not in ALERT_OWNER_STATUSES or (status == "snoozed") != (until is not None):
        raise _bad()
    changes: dict[str, Any] = {"status": status}
    if until is not None:
        changes["snoozed_until"] = until
    return _alert(ctx, changes, ("status", "snoozed_until"), _alert_owner_write, whole=True)


def _signal_snoozed(ctx: _Ctx) -> Outcome:
    """``signal.snoozed`` -> ``store.signals.snooze``."""
    from cashu.modules.investments.store import journal, signals

    until = _opt_ts(ctx.ev.data, "until", required=True)
    sid = ctx.need("inv_signals")
    row = journal.signal(ctx.s, ctx.pid, sid)
    if row is None:
        return GONE
    if not ctx.winners("inv_signals", sid, ("snoozed_until",)):
        return Outcome("lost", "older")
    with ctx.inbound():
        signals.snooze(ctx.s, row, until)
    ctx.stamp("inv_signals", sid, ("snoozed_until",))
    return Outcome("applied")


def _signal_closed(ctx: _Ctx) -> Outcome:
    """``signal.closed`` by an owner action that rides in the batch of an allowed event: covered by the
    sibling's service (``alerts.mute`` / ``update`` and ``research.dismiss`` close the signal). Every
    other close (rule outcomes, expiries, deletes) is the lease holder's or not allowed here."""
    data = ctx.ev.data
    if data.get("status") not in ("resolved", "expired") or not isinstance(data.get("reason"), str):
        raise _bad()
    if data["reason"] not in COVERED_CLOSE_REASONS:
        raise _Reject("disallowed")
    return Outcome("covered")


def _decision_recorded(ctx: _Ctx) -> Outcome:
    """``decision.recorded`` (APPEND) -> ``store.journal.record_decision`` (acknowledges its signals)."""
    from cashu.modules.investments.store import journal

    data = ctx.ev.data
    signals_ = data.get("signals")
    action = data.get("action")
    if not isinstance(signals_, list) or not all(_is_gid(g) for g in signals_) or len(set(signals_)) != len(signals_):
        raise _bad()
    if action not in DECISION_ACTIONS:
        raise _bad()
    for ref in ("instrument", "account"):
        if data.get(ref) is not None and not _is_gid(data[ref]):
            raise _bad()
    currency = _opt_str(data, "currency")
    if currency is not None and not ASSET_CURRENCY_RE.match(currency):
        raise _bad()
    quantity, price = _opt_decimal(data, "quantity"), _opt_decimal(data, "price")
    reason = _opt_str(data, "reason")
    if ctx.local("inv_decisions") is not None:
        return Outcome("applied", "exists")
    rows = []
    for g in signals_:
        row = journal.signal(ctx.s, ctx.pid, ctx.need("inv_signals", g))
        if row is None:
            raise _Park("unknown-gid")
        rows.append(row)
    instrument_id = ctx.need("inv_instruments", data["instrument"]) if data.get("instrument") else None
    account_id = ctx.need("accounts", data["account"]) if data.get("account") else None
    with ctx.inbound(bind={"inv_decisions": ctx.ev.gid}):
        decision = journal.record_decision(
            ctx.s,
            ctx.pid,
            action=action,
            signal_rows=rows,
            instrument_id=instrument_id,
            account_id=account_id,
            quantity=quantity,
            price=price,
            currency=currency,
            reason=reason,
            now=ctx.time("created_at"),
        )
    ctx.map("inv_decisions", decision.id)
    return Outcome("applied")


def _review_done(ctx: _Ctx) -> Outcome:
    """``review.done`` (APPEND) -> ``core.reviews.mark_done``."""
    from . import reviews

    data = ctx.ev.data
    module = data.get("module")
    stats = data.get("stats")
    if not (isinstance(module, str) and MODULE_RE.match(module)) or not isinstance(stats, dict):
        raise _bad()
    done_at = _opt_ts(data, "doneAt")
    notes = _opt_str(data, "notes")
    if ctx.local("reviews") is not None:
        return Outcome("applied", "exists")
    with ctx.inbound(bind={"reviews": ctx.ev.gid}):
        row = reviews.mark_done(
            ctx.s, ctx.pid, module, notes, stats, now=ctx.time("done_at", done_at)
        )
    ctx.map("reviews", row.id)
    return Outcome("applied")


def _note(ctx: _Ctx):
    from cashu.modules.investments.research import service as research

    nid = ctx.need("research_notes")
    return nid, research.note(ctx.s, ctx.pid, nid)


def _note_read(ctx: _Ctx) -> Outcome:
    """``note.read`` -> research ``mark_read`` (by id)."""
    from cashu.modules.investments.research import service as research

    nid, row = _note(ctx)
    if row is None:
        return GONE
    if not ctx.winners("research_notes", nid, ("read_at",)):
        return Outcome("lost", "older")
    with ctx.inbound():
        research.mark_read(ctx.s, ctx.profile, ids=[nid], now=ctx.time("read_at"))
    ctx.stamp("research_notes", nid, ("read_at",))
    return Outcome("applied")


def _note_dismissed(ctx: _Ctx) -> Outcome:
    """``note.dismissed`` -> research ``dismiss`` (its research signal closes when it was the last note)."""
    from cashu.modules.investments.research import service as research

    _opt_ts(ctx.ev.data, "cooldownUntil", required=True)
    nid, row = _note(ctx)
    if row is None:
        return GONE
    cols = ("dismissed_at", "cooldown_until")
    if len(ctx.winners("research_notes", nid, cols)) < len(cols):
        return Outcome("lost", "older")
    try:
        with ctx.inbound():
            research.dismiss(ctx.s, ctx.profile, nid, now=ctx.time("dismissed_at"))
    except _not_found_errors():
        return GONE
    ctx.stamp("research_notes", nid, cols)
    return Outcome("applied")


HANDLERS: dict[str, Callable[[_Ctx], Outcome]] = {
    "txn.categorySet": _txn_category_set,
    "categoryRule.set": _category_rule_set,
    "alert.updated": _alert_updated,
    "alert.statusSet": _alert_status_set,
    "signal.snoozed": _signal_snoozed,
    "signal.closed": _signal_closed,
    "decision.recorded": _decision_recorded,
    "review.done": _review_done,
    "note.read": _note_read,
    "note.dismissed": _note_dismissed,
}
"""The inbound allow-list (S31b): the edits another device (the phone, S43) may make."""


# --------------------------------------------------------------------------- #
# Apply
# --------------------------------------------------------------------------- #


def _record(s: Session, ev: Event, pid: int, outcome: Outcome) -> None:
    row = s.get(SyncInbound, ev.eid)
    if row is None:
        row = SyncInbound(eid=ev.eid, type=ev.type, hlc=ev.hlc, digest=ev.digest, status=outcome.status)
    row.profile_id, row.gid = pid, ev.gid
    row.status, row.reason = outcome.status, outcome.reason
    row.body = ev.raw if outcome.status == "parked" else None
    row.settled_at = None if outcome.status == "parked" else utcnow()
    s.add(row)


def _vault(s: Session, pid: int) -> str | None:
    return s.exec(select(SyncVault.vault_id).where(SyncVault.profile_id == pid)).first()


def apply_one(s: Session, raw: Any, *, profile_id: int) -> Outcome:
    """Apply one event in the caller's transaction (its writes and its ``sync_inbound`` row commit
    together). A service refusal raises ``_Refused``: roll back, then :func:`_record_refusal`."""
    try:
        ev = parse_event(raw)
    except _Reject as r:
        return Outcome("rejected", r.reason)
    vault = _vault(s, profile_id)
    if vault is None:
        return Outcome("rejected", "vault-not-linked")
    if ev.vault != vault:
        return Outcome("rejected", "profile-mismatch")
    existing = s.get(SyncInbound, ev.eid)
    if existing is not None:
        if existing.digest != ev.digest or existing.profile_id != profile_id:
            return Outcome("rejected", "eid-reused")
        if existing.status != "parked":
            return Outcome("duplicate")
    try:
        handler = HANDLERS.get(ev.type)
        if handler is None:
            raise _Reject("disallowed")
        if ev.v != 1:
            raise _Reject("unsupported-version")
        if ev.cause is not None:
            cause = s.get(SyncInbound, ev.cause)
            if cause is None or cause.status == "parked":
                raise _Park("cause-pending")
        try:
            outcome = handler(_Ctx(s, ev, profile_id))
        except _service_errors() as e:
            raise _Refused(type(e).__name__) from None
    except _Park as p:
        outcome = Outcome("parked", p.reason)
    except _Reject as r:
        if not r.persist:
            return Outcome("rejected", r.reason)
        outcome = Outcome("rejected", r.reason)
    _record(s, ev, profile_id, outcome)
    return outcome


def _record_refusal(s: Session, raw: dict, profile_id: int) -> Outcome:
    outcome = Outcome("rejected", "service-refused")
    _record(s, parse_event(raw), profile_id, outcome)
    return outcome


def _flatten(items: Iterable[Any]) -> Iterator[Any]:
    for item in items:
        if isinstance(item, list):
            yield from item
        else:
            yield item


def _sort_key(raw: Any) -> tuple[int, str, str]:
    if isinstance(raw, dict) and isinstance(raw.get("hlc"), str) and isinstance(raw.get("eid"), str):
        return (1, raw["hlc"], raw["eid"])
    return (0, "", "")


def parked(s: Session, profile_id: int) -> list[dict]:
    """Bodies of the profile's parked events (retried by every run)."""
    return [
        r.body
        for r in s.exec(
            select(SyncInbound).where(
                SyncInbound.profile_id == profile_id, SyncInbound.status == "parked"
            )
        ).all()
        if isinstance(r.body, dict)
    ]


def apply_events(
    events: Iterable[Any],
    *,
    profile_id: int,
    session_factory: Callable[[], AbstractContextManager[Session]] | None = None,
    retry_parked: bool = True,
) -> dict[str, Any]:
    """Apply logical envelopes (a list item is one batch, flattened) of one profile's vault, plus its
    parked events, in ``(hlc, eid)`` order, each in its own transaction. Returns counts per status and
    rejection reason. Never logs a value: rejections log their type and reason code."""
    if not sync_outbox.enabled():
        raise SyncApplyError("inbound events need CASHU_SYNC=1 (local edits must be captured)")
    if session_factory is None:
        from .db import get_session

        session_factory = get_session
    items = list(_flatten(events))
    retried = 0
    if retry_parked:
        with session_factory() as s:
            waiting = parked(s, profile_id)
        seen = {i.get("eid") for i in items if isinstance(i, dict)}
        fresh = [w for w in waiting if w.get("eid") not in seen]
        retried = len(fresh)
        items.extend(fresh)
    items.sort(key=_sort_key)
    counts: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    for raw in items:
        try:
            with session_factory() as s:
                outcome = apply_one(s, raw, profile_id=profile_id)
        except _Refused:
            with session_factory() as s:
                outcome = _record_refusal(s, raw, profile_id)
        counts[outcome.status] += 1
        if outcome.status in ("rejected", "parked", "lost") and outcome.reason:
            reasons[f"{outcome.status}:{outcome.reason}"] += 1
        if outcome.status == "rejected":
            log.warning(
                "sync apply: rejected an inbound event (type=%s, reason=%s)", safe_type(raw), outcome.reason
            )
    summary: dict[str, Any] = {k: counts.get(k, 0) for k in STATUSES}
    summary["retried"] = retried
    summary["reasons"] = dict(sorted(reasons.items()))
    return summary


def apply_lines(lines: Iterable[str], *, profile_id: int, **kwargs: Any) -> dict[str, Any]:
    """``cashu sync apply --stdin``: JSON lines, each one envelope or a JSON array (one batch). A line
    that is not JSON counts as a rejected ``bad-json``."""
    events: list[Any] = []
    bad_json = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            bad_json += 1
    summary = apply_events(events, profile_id=profile_id, **kwargs)
    if bad_json:
        summary["rejected"] += bad_json
        summary["reasons"]["rejected:bad-json"] = bad_json
        log.warning("sync apply: %d input line(s) are not JSON", bad_json)
    return summary
