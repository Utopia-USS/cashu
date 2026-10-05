"""What the worker tells the user: immediate signal notifications and the weekly digest.

Immediate (per profile, policy = the profile's strategy ``notifications``):

- the daily check writes one ``inv_notification_log`` entry per (signal, severity) for new and
  escalated signals of the immediate severities; the worker delivers the entries not sent yet;
- the owner's actions and the policy are checked again at delivery: an entry whose signal is
  resolved / expired, acknowledged, decided after the entry was written, or whose severity is no
  longer immediate, is closed out (``skipped:closed`` / ``skipped:acknowledged`` /
  ``skipped:decided`` / ``skipped:policy``); an entry of a snoozed signal stays pending until the
  snooze ends (F5 R5);
- each entry is claimed before delivery (``sent_at`` set in its own transaction, at most once);
  a failed delivery releases the claim, and the run stops notifying that profile (the notifier
  is likely broken; the next run tries again);
- at most ``MAX_PER_PROFILE`` separate notifications per profile and run, the rest in one
  summary notification (a long-idle worker never floods the screen).

Weekly digest: on the profile's digest weekday, one notification per profile and day
("N sygnałów do przeglądu", the signals waiting for a decision), recorded in the worker state
before it is sent.

Texts are Polish (UI data). Each notification carries a ``finanse://`` link (the signal, the
investments view, the weekly review) that Finanse.app opens on a click.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass, field

from . import investments as inv
from .notifier import Notification, Notifier, investments_link, review_link, signal_link
from .state import WorkerState

MAX_PER_PROFILE = 3
SEVERITY_SUBTITLE = {"action": "Sygnał do działania", "info": "Sygnał informacyjny"}


def signals_phrase(n: int) -> str:
    """Polish plural: 1 sygnał, 2-4 sygnały (not 12-14), 0 / 5+ sygnałów."""
    if n == 1:
        return "1 sygnał"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"{n} sygnały"
    return f"{n} sygnałów"


def title(profile) -> str:
    return f"finanse: {profile.name}"


@dataclass
class DeliveryResult:
    delivered: int = 0
    summarized: int = 0
    skipped: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.failed:
            return "failed" if not (self.delivered or self.summarized) else "partial"
        return "ok"

    def stats(self) -> dict:
        return {
            "delivered": self.delivered,
            "summarized": self.summarized,
            "skipped": self.skipped,
            "failed": self.failed,
        }


def deliver_pending(
    profile, notifier: Notifier, *, now: dt.datetime, session_factory: Callable
) -> DeliveryResult:
    out = DeliveryResult()
    with session_factory() as s:
        policy = inv.policy(s, profile)
        items = inv.pending(s, profile.id)
    due: list[inv.PendingNotification] = []
    for item in items:
        if item.snoozed(now):
            continue  # postponed by the owner: delivered (or closed out) after the snooze
        if item.signal_status not in inv.OPEN_STATUSES:
            reason = "skipped:closed"
        elif item.signal_status != inv.DELIVERABLE_STATUS:
            reason = "skipped:acknowledged"
        elif item.decided:
            reason = "skipped:decided"
        elif item.severity not in policy.immediate:
            reason = "skipped:policy"
        else:
            due.append(item)
            continue
        if inv.claim(session_factory, item.log_id, reason, now):
            out.skipped += 1

    for item in due[:MAX_PER_PROFILE]:
        if not inv.claim(session_factory, item.log_id, notifier.name, now):
            continue  # delivered by another process meanwhile
        delivery = notifier.send(
            Notification(
                title=title(profile),
                subtitle=SEVERITY_SUBTITLE.get(item.severity, "Sygnał"),
                message=item.message,
                group=f"finanse-signal-{item.signal_id}",
                url=signal_link(profile.slug, item.signal_id),
            )
        )
        if not delivery.ok:
            inv.release(session_factory, item.log_id)
            out.failed += 1
            out.errors.append(delivery.error or "delivery failed")
            return out
        out.delivered += 1

    rest = due[MAX_PER_PROFILE:]
    if rest:
        channel = f"{notifier.name}:summary"
        claimed = [i for i in rest if inv.claim(session_factory, i.log_id, channel, now)]
        if claimed:
            delivery = notifier.send(
                Notification(
                    title=title(profile),
                    subtitle="Nowe sygnały",
                    message=f"I jeszcze {signals_phrase(len(claimed))} - szczegóły w aplikacji.",
                    group=f"finanse-signals-{profile.id}",
                    url=investments_link(profile.slug),
                )
            )
            if delivery.ok:
                out.summarized += len(claimed)
            else:
                for item in claimed:
                    inv.release(session_factory, item.log_id)
                out.failed += len(claimed)
                out.errors.append(delivery.error or "delivery failed")
    return out


@dataclass
class DigestResult:
    status: str  # sent | already_sent | not_due | failed
    count: int = 0
    weekday: int = 7
    error: str | None = None


def digest_message(count: int) -> str:
    if count == 0:
        return "Brak sygnałów do przeglądu"
    return f"{signals_phrase(count)} do przeglądu"


def send_digest(
    profile,
    notifier: Notifier,
    *,
    today: dt.date,
    state: WorkerState,
    save_state: Callable[[WorkerState], object],
    session_factory: Callable,
) -> DigestResult:
    """The weekly digest for one profile, when today is its digest weekday and it was not sent
    today yet. The date is stored before sending (at most once a day); a failed send undoes it."""
    with session_factory() as s:
        policy = inv.policy(s, profile)
        if today.isoweekday() != policy.digest_weekday:
            return DigestResult("not_due", weekday=policy.digest_weekday)
        count = inv.review_count(s, profile.id)
    key = str(profile.id)
    if state.digests.get(key) == today.isoformat():
        return DigestResult("already_sent", count, policy.digest_weekday)
    previous = state.digests.get(key)
    state.digests[key] = today.isoformat()
    save_state(state)
    delivery = notifier.send(
        Notification(
            title=title(profile),
            subtitle="Przegląd tygodniowy",
            message=digest_message(count),
            group=f"finanse-digest-{profile.id}",
            url=review_link(profile.slug),
        )
    )
    if not delivery.ok:
        if previous is None:
            state.digests.pop(key, None)
        else:
            state.digests[key] = previous
        save_state(state)
        return DigestResult("failed", count, policy.digest_weekday, delivery.error)
    return DigestResult("sent", count, policy.digest_weekday)
