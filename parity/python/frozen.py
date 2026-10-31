"""A frozen wall clock for the golden run (no freezegun in the venv; same idea, smaller).

``install(instant)`` replaces ``date`` / ``datetime`` with subclasses whose ``today()`` / ``now()`` /
``utcnow()`` return the frozen instant, both on the ``datetime`` module itself (for call-time
``from datetime import date``) and on every already imported ``cashu.*`` module that bound the classes
at import time. A metaclass keeps ``isinstance(real_date, date)`` true, and the constructors return
real ``date`` / ``datetime`` objects, so nothing fake ever reaches SQLAlchemy, pydantic or the output.
Libraries outside ``cashu`` keep their own references (their type maps stay keyed by the real classes).

Install it AFTER importing every cashu module (``golden.import_all``) and set ``TZ`` before the
interpreter starts: local time is derived from the process time zone.
"""

from __future__ import annotations

import datetime as _dt
import sys
import time

_real_date = _dt.date
_real_datetime = _dt.datetime
_frozen: _real_datetime | None = None  # aware (UTC)


def _now_utc() -> _real_datetime:
    assert _frozen is not None, "frozen clock not installed"
    return _frozen


class _DateMeta(type):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _real_date)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _real_date)


class _DatetimeMeta(_DateMeta):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _real_datetime)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _real_datetime)


class FrozenDate(_real_date, metaclass=_DateMeta):
    def __new__(cls, *args, **kwargs):
        return _real_date(*args, **kwargs)

    @classmethod
    def today(cls):
        local = _now_utc().astimezone()
        return _real_date(local.year, local.month, local.day)


class FrozenDatetime(_real_datetime, metaclass=_DatetimeMeta):
    def __new__(cls, *args, **kwargs):
        return _real_datetime(*args, **kwargs)

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return _now_utc().astimezone().replace(tzinfo=None)
        return _now_utc().astimezone(tz)

    @classmethod
    def today(cls):
        return cls.now()

    @classmethod
    def utcnow(cls):
        return _now_utc().replace(tzinfo=None)


def install(local_iso: str) -> _real_datetime:
    """Freeze the clock at ``local_iso`` (naive, in the process time zone). Returns the UTC instant."""
    global _frozen
    time.tzset()
    _frozen = _real_datetime.fromisoformat(local_iso).astimezone(_dt.UTC)
    _dt.date = FrozenDate
    _dt.datetime = FrozenDatetime
    patched = 0
    for name, module in list(sys.modules.items()):
        if module is None or not (name == "cashu" or name.startswith("cashu.")):
            continue
        for attr, value in list(vars(module).items()):
            if value is _real_date:
                setattr(module, attr, FrozenDate)
                patched += 1
            elif value is _real_datetime:
                setattr(module, attr, FrozenDatetime)
                patched += 1
    return _frozen
