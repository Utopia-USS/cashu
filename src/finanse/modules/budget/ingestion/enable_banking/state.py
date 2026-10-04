"""Persist authorized Enable Banking session ids so they can be re-synced.

Sessions stay valid for up to ~90 days, so saving {bank: session_id} lets
`finanse eb resync` refresh everything without re-doing the bank login until the
consent expires. Stored in the data dir (see core.paths) with owner-only
permissions: a session id works like an access token.
"""

from __future__ import annotations

import json
import os

from finanse.core import paths


def load_sessions() -> dict[str, str]:
    path = paths.eb_sessions_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_session(bank: str, session_id: str) -> None:
    data = load_sessions()
    data[bank] = session_id
    path = paths.eb_sessions_path()
    paths.ensure_private_dir(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(data, indent=2))
    if os.name == "posix":
        os.chmod(path, 0o600)
