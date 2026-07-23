"""Persist authorized Enable Banking session ids so they can be re-synced.

Sessions stay valid for up to ~90 days, so saving {bank: session_id} lets
`finanse eb resync` refresh everything without re-doing the bank login until the
consent expires. Stored under data/ (gitignored — it's an access token).
"""

from __future__ import annotations

import json

from ...config import PROJECT_ROOT

_PATH = PROJECT_ROOT / "data" / "eb_sessions.json"


def load_sessions() -> dict[str, str]:
    if not _PATH.exists():
        return {}
    try:
        data = json.loads(_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_session(bank: str, session_id: str) -> None:
    data = load_sessions()
    data[bank] = session_id
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    _PATH.write_text(json.dumps(data, indent=2))
