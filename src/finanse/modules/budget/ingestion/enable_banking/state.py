"""Persist authorized Enable Banking session ids so they can be re-synced.

Sessions stay valid for up to ~90 days, so saving them lets `finanse eb resync`
(and the dashboard's Synchronizuj) refresh everything without re-doing the bank
login until the consent expires. Sessions belong to a profile and an institution;
a profile can hold several sessions of one institution (two people with mBank in
one household profile). Stored in the data dir (see core.paths) with owner-only
permissions: a session id works like an access token.

File format (version 2)::

    {"version": 2, "profiles": {"<slug>": [
        {"institution": "mbank", "session_id": "...", "saved_at": "<ISO time>"}]}}

The upstream format ``{"<bank>": "<session id>"}`` is read as the sessions of the
profile the legacy data was migrated into (``legacy_profile``) and rewritten in
the new format on the next save.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import asdict, dataclass

from finanse.core import paths

VERSION = 2


@dataclass(frozen=True)
class SavedSession:
    institution: str
    session_id: str
    saved_at: str | None = None


def _read_raw() -> dict:
    path = paths.eb_sessions_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _read(legacy_profile: str | None) -> dict[str, list[SavedSession]]:
    data = _read_raw()
    if data.get("version") == VERSION:
        out: dict[str, list[SavedSession]] = {}
        for slug, entries in (data.get("profiles") or {}).items():
            out[slug] = [
                SavedSession(e["institution"], e["session_id"], e.get("saved_at"))
                for e in entries or []
                if isinstance(e, dict) and e.get("institution") and e.get("session_id")
            ]
        return out
    # Upstream format: {bank: session_id}, one global session per bank.
    legacy = [SavedSession(k, v) for k, v in data.items() if isinstance(v, str) and v]
    return {legacy_profile: legacy} if legacy_profile and legacy else {}


def _write(sessions: dict[str, list[SavedSession]]) -> None:
    path = paths.eb_sessions_path()
    paths.ensure_private_dir(path.parent)
    body = {
        "version": VERSION,
        "profiles": {slug: [asdict(e) for e in entries] for slug, entries in sessions.items()},
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(body, indent=2))
    if os.name == "posix":
        os.chmod(path, 0o600)


def load_sessions(profile: str, *, legacy_profile: str | None = None) -> list[SavedSession]:
    """Saved sessions of a profile (by slug)."""
    return list(_read(legacy_profile).get(profile, []))


def save_session(
    profile: str,
    institution: str,
    session_id: str,
    *,
    keep_others: bool = False,
    legacy_profile: str | None = None,
) -> None:
    """Remember a session for the profile. By default it replaces the profile's
    earlier sessions of the same institution (a re-login); ``keep_others`` keeps
    them (a second person's login at the same bank)."""
    sessions = _read(legacy_profile)
    entries = [
        e
        for e in sessions.get(profile, [])
        if e.session_id != session_id and (keep_others or e.institution != institution)
    ]
    entries.append(
        SavedSession(institution, session_id, dt.datetime.now(dt.UTC).isoformat(timespec="seconds"))
    )
    sessions[profile] = entries
    _write(sessions)


def forget_session(profile: str, session_id: str, *, legacy_profile: str | None = None) -> bool:
    sessions = _read(legacy_profile)
    entries = sessions.get(profile, [])
    kept = [e for e in entries if e.session_id != session_id]
    if len(kept) == len(entries):
        return False
    sessions[profile] = kept
    _write(sessions)
    return True
