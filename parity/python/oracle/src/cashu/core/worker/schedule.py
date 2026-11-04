"""When the background worker runs: once a day at a local wall-clock time (default 07:30)."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

_HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


class ScheduleError(ValueError):
    """An invalid time of day."""


@dataclass(frozen=True)
class Schedule:
    """Daily at ``hour:minute`` local time (launchd ``StartCalendarInterval``)."""

    hour: int = 7
    minute: int = 30

    def __post_init__(self) -> None:
        if not (0 <= self.hour <= 23 and 0 <= self.minute <= 59):
            raise ScheduleError(
                f"Invalid time {self.hour}:{self.minute:02d} (expected 00:00-23:59)"
            )

    @classmethod
    def parse(cls, text: str) -> Schedule:
        """``"7:30"`` / ``"07:30"`` -> Schedule(7, 30)."""
        m = _HHMM.match(text.strip())
        if not m:
            raise ScheduleError(f"Invalid time {text!r} (expected HH:MM)")
        return cls(int(m.group(1)), int(m.group(2)))

    @property
    def time(self) -> str:
        return f"{self.hour:02d}:{self.minute:02d}"

    def next_run(self, now: dt.datetime) -> dt.datetime:
        """The first scheduled moment strictly after ``now`` (same tzinfo as ``now``)."""
        candidate = now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        if candidate <= now:
            candidate += dt.timedelta(days=1)
        return candidate


DEFAULT_SCHEDULE = Schedule()


def local_now() -> dt.datetime:
    """Aware local time (the schedule is local wall-clock time)."""
    return dt.datetime.now().astimezone()
