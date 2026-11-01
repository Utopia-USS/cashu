"""The golden checks: one function per check, registered in ``CHECKS`` (run order = list order).

A check function takes the :class:`Ctx` and returns a plain structure (dicts, lists, dataclasses,
Decimals, dates ...); the runner canonicalises it (``canon.Canon``, with the check's id overrides) and
counts its rows. Per-profile results are keyed by the profile's natural key. A check never writes
through the session it is given (the runner rolls back after each check anyway) and never reaches the
network (``offline.py``). Something a check cannot reach without a running server or the network is
recorded with :meth:`Ctx.skip` instead of being faked.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import canon


@dataclass
class Ctx:
    dataset: str
    as_of: dt.date
    session: Any
    ids: canon.IdMap
    profiles: list[Any]
    skipped: list[dict] = field(default_factory=list)
    cache: dict = field(default_factory=dict)

    @classmethod
    def open(cls, dataset: str, *, frozen_clock: str) -> Ctx:
        from sqlmodel import Session, select

        from cashu.core.db import engine
        from cashu.core.models import Profile

        session = Session(engine)
        profiles = list(session.exec(select(Profile).order_by(Profile.slug)).all())
        ids = canon.IdMap(session)
        return cls(
            dataset=dataset,
            as_of=dt.date.fromisoformat(frozen_clock[:10]),
            session=session,
            ids=ids,
            profiles=profiles,
        )

    def pkey(self, profile) -> str:
        return self.ids.key("profiles", profile.id)

    def enabled(self, profile) -> set[str]:
        from cashu.core import profiles

        return set(profiles.enabled_modules(self.session, profile.id))

    def with_module(self, module: str) -> list[Any]:
        return [p for p in self.profiles if module in self.enabled(p)]

    def skip(self, check: str, item: str, reason: str) -> None:
        entry = {"check": check, "item": item, "reason": reason}
        if entry not in self.skipped:
            self.skipped.append(entry)

    def reset(self) -> None:
        self.session.rollback()
        self.session.expire_all()


def _size(value: Any) -> int:
    if isinstance(value, (list, dict)):
        return len(value)
    return 1


@dataclass(frozen=True)
class Check:
    name: str
    fn: Callable[[Ctx], Any]
    overrides: dict[str, str] = field(default_factory=dict)
    per_profile: bool = True

    def run(self, ctx: Ctx) -> tuple[Any, int]:
        raw = self.fn(ctx)
        data = canon.Canon(ctx.ids, self.overrides).value(raw)
        if self.per_profile and isinstance(data, dict):
            rows = sum(_size(v) for v in data.values())
        else:
            rows = _size(data)
        return data, rows


def _registry() -> list[Check]:
    from . import budget, budget_derived, budget_ingestion, core, investments, loans_assets, mcp, store

    return [
        *core.CHECKS,
        *budget.CHECKS,
        *budget_ingestion.CHECKS,
        *budget_derived.CHECKS,
        *loans_assets.CHECKS,
        *investments.CHECKS,
        *mcp.CHECKS,
        *store.CHECKS,
    ]


CHECKS: list[Check] = _registry()
