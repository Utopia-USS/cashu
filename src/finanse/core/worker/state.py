"""The worker's own bookkeeping: ``<data dir>/worker/state.json``.

Holds what has no table of its own (no schema change for the worker):

- ``digests``: the date the weekly digest was last sent, per profile id (one digest per day);
- ``budget``: per profile id, the last bank sync attempt / success, a throttle deadline after a
  rate limit and the last error (so the worker never hammers a bank);
- ``last_run``: a summary of the last worker run (status, times, one line per job).

Written atomically (temp file + rename), owner-only (0600 in a 0700 dir). Only the worker writes
it, under the worker run lock. A missing or corrupt file reads as empty.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import paths

VERSION = 1
STATE_FILENAME = "state.json"


def worker_dir() -> Path:
    return paths.data_dir() / "worker"


def state_path() -> Path:
    return worker_dir() / STATE_FILENAME


@dataclass
class WorkerState:
    digests: dict[str, str] = field(default_factory=dict)  # profile id -> ISO date
    budget: dict[str, dict[str, Any]] = field(default_factory=dict)  # profile id -> bookkeeping
    last_run: dict[str, Any] | None = None

    def to_json(self) -> dict:
        return {
            "version": VERSION,
            "digests": self.digests,
            "budget": self.budget,
            "last_run": self.last_run,
        }


def load(path: Path | None = None) -> WorkerState:
    path = path or state_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return WorkerState()
    if not isinstance(raw, dict):
        return WorkerState()
    digests = raw.get("digests") if isinstance(raw.get("digests"), dict) else {}
    budget = raw.get("budget") if isinstance(raw.get("budget"), dict) else {}
    last_run = raw.get("last_run") if isinstance(raw.get("last_run"), dict) else None
    return WorkerState(
        digests={str(k): str(v) for k, v in digests.items()},
        budget={str(k): v for k, v in budget.items() if isinstance(v, dict)},
        last_run=last_run,
    )


def save(state: WorkerState, path: Path | None = None) -> Path:
    path = path or state_path()
    paths.ensure_private_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state.to_json(), f, indent=2, sort_keys=True)
        if os.name == "posix":
            os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path
