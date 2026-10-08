"""The one entry of an instrument in a profile (F12): where it shows, never whether it exists.

- ``held``: in the current holdings (quantity > 0, the snapshot the views use); a held instrument that
  is also on the watchlist is ``held`` (its watch row stays);
- ``watched``: an active watchlist row (``removed_at`` unset) and not held;
- ``saved``: referenced by the profile (``profile_instrument_ids``: a removed watch row, research notes,
  theses, alerts, ...) but neither held nor watched. Nothing about it is ever dropped;
- ``new`` (search results only): not referenced by the profile.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from sqlmodel import Session

from cashu.core.models import Profile

from ..research.service import held_instrument_ids
from ..store import alerts as alert_store
from ..store import instruments
from . import portfolio

EntryState = Literal["held", "watched", "saved", "new"]
HELD, WATCHED, SAVED, NEW = "held", "watched", "saved", "new"


def entry_states(
    session: Session,
    profile: Profile,
    ids: Iterable[int],
    *,
    referenced: set[int] | None = None,
) -> dict[int, EntryState]:
    """The entry state of every instrument in ``ids`` for ``profile`` (``referenced``: the profile's
    ``profile_instrument_ids`` when the caller has them already)."""
    wanted = set(ids)
    if not wanted:
        return {}
    assert profile.id is not None
    held = held_instrument_ids(session, profile.id, portfolio.today())
    watched = alert_store.watched_instrument_ids(session, profile.id)
    if referenced is None:
        referenced = instruments.profile_instrument_ids(session, profile.id)
    out: dict[int, EntryState] = {}
    for iid in wanted:
        if iid in held:
            out[iid] = HELD
        elif iid in watched:
            out[iid] = WATCHED
        elif iid in referenced:
            out[iid] = SAVED
        else:
            out[iid] = NEW
    return out
