"""Worker glue for fetch connectors (job ``connectors.fetch``, F10), polite like the budget sync.

Per profile, every binding of an approved fetch connector of an enabled module is synced at most once
per ``MIN_INTERVAL`` (20 h), never during the 48 h backoff after a ``rate_limited`` answer, and only
with every declared secret set. The attempt is recorded on the binding (``last_run_at``) before the
connector process starts, so a crash cannot turn into a retry loop. One failing binding never stops
the others. A sync that stores a new pending proposal (the first sync of a binding always does) is
announced with one notification per proposal (counts only, no amounts).

The sync itself is ``connectors.sync.sync_binding`` (fetch, preview, commit or proposal). Offline runs
skip the job. A profile without fetch bindings gets no job row.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from typing import Any

from .notifier import Notification, Notifier, investments_link

JOB = "connectors.fetch"
MODULES = ("investments", "budget")
_log = logging.getLogger("finanse.worker.connectors")


@dataclass
class FetchOutcome:
    status: str  # ok | partial | failed | skipped
    detail: str | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    code: str | None = None
    params: dict[str, Any] = field(default_factory=dict)


def _records_phrase(n: int) -> str:
    if n == 1:
        return "1 nowy rekord"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"{n} nowe rekordy"
    return f"{n} nowych rekordów"


def notify_proposal(notifier: Notifier, profile, result) -> bool:
    """One notification for a new pending sync proposal (connector name and a count only)."""
    new = (result.preview or {}).get("new", 0)
    delivery = notifier.send(
        Notification(
            title=f"finanse: {profile.name}",
            subtitle="Import czeka na zatwierdzenie",
            message=f"{result.connector_name}: {_records_phrase(int(new))}",
            group=f"finanse-connector-{result.binding_id}",
            url=investments_link(profile.slug) if result.module == "investments" else None,
        )
    )
    return delivery.ok


def run(
    profile,
    modules: set[str],
    *,
    now: dt.datetime,
    notifier: Notifier | None,
    offline: bool = False,
    sandbox=None,
) -> FetchOutcome | None:
    """Sync the due bindings of ``profile`` (``modules`` = its enabled modules). None = the profile
    has no fetch binding (no job row)."""
    from finanse.core.connectors import sync

    wanted = [m for m in MODULES if m in modules]
    if not wanted or not any(sync.bindings_of(profile, m) for m in wanted):
        return None
    if offline:
        return FetchOutcome("skipped", "offline run", code="disabled_for_run")
    results: list = []
    for module in wanted:
        results += sync.run_due(profile, module, now=now, sandbox=sandbox)
    synced = [r for r in results if isinstance(r, sync.SyncResult)]
    skipped = [r for r in results if isinstance(r, sync.Due)]
    failed_runs = [r for r in synced if not r.run.ok or r.problem is not None]
    crashed = [r for r in skipped if r.reason == "failed"]
    proposals = [r for r in synced if r.proposal_id is not None]
    notified = 0
    if notifier is not None:
        for r in proposals:
            try:
                notified += int(notify_proposal(notifier, profile, r))
            except Exception:  # noqa: BLE001 - a notification never fails the job
                _log.exception("connector proposal notification failed")
    stats = {
        "synced": len(synced),
        "proposals": len(proposals),
        "committed": sum(1 for r in synced if r.committed is not None),
        "failed": len(failed_runs) + len(crashed),
        "skipped": len(skipped) - len(crashed),
        "notified": notified,
    }
    bad = len(failed_runs) + len(crashed)
    ran = len(synced) + len(crashed)
    if ran == 0:
        return FetchOutcome("skipped", "nothing due", stats, code="connectors_not_due")
    if bad == 0:
        return FetchOutcome("ok", None, stats)
    first = failed_runs[0] if failed_runs else None
    # Value-free: the error kind or the problem code, never the connector's message.
    kind = (first.run.error_kind or (first.problem or {}).get("code")) if first else "crash"
    detail = f"{bad} of {ran} connector syncs failed ({kind})"
    return FetchOutcome("failed" if bad == ran else "partial", detail, stats)
