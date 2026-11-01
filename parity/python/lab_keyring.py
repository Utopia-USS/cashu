"""A ``keyring`` backend over a 0600 JSON file for the bridge harness (S31a spec 9.2).

TRANSITIONAL(S47): the lab stand-in for the OS keychain while the sync daemon is a plain Node process
with a file key store (spec D3). The TS daemon writes the vault's gid salt into the same file, so the
Python CLI children of a harness run read it through ``keyring`` like the app reads the keychain
(``core/sync_keys.py`` ``gid_salt``):

    PYTHONPATH=<repo root>
    PYTHON_KEYRING_BACKEND=parity.python.lab_keyring.FileKeyring
    CASHU_LAB_KEYRING=<run>/keys/keyring.json

(``parity`` and ``parity/python`` have no ``__init__.py``: with the repo root on ``PYTHONPATH`` they
import as namespace packages.)

File format, exactly: ``{"format": 1, "entries": {<service>: {<account>: <password>}}}``; the gid salt
is service ``cashu``, account ``cashu.vault.<vault id>.gidsalt``, password 64 lower-case hex.

Refuses (``LabKeyringRefused``, deliberately not a ``KeyringError``: callers that treat a keyring error
as "no keychain" must not silently go on without the salt) when ``CASHU_LAB_KEYRING`` is unset, the
resolved path is outside ``~/cashu-lab`` (the real home of the user, not ``$HOME``, which the harness
points into the run dir; compared case-insensitively, APFS is), the file's mode is wider than 0600, or
the file is not in the format above. Writes are atomic (temp file in the same dir, 0600, rename).
Never logs or prints a value.
"""

from __future__ import annotations

import json
import os
import pwd
import stat
import tempfile
from pathlib import Path

from jaraco.classes import properties
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

ENV = "CASHU_LAB_KEYRING"
FORMAT = 1
LAB_ROOT = Path(pwd.getpwuid(os.getuid()).pw_dir) / "cashu-lab"
"""The only tree the file may live in (module attribute so tests can point it at a temp dir)."""


class LabKeyringRefused(RuntimeError):
    """The lab keyring file is missing from the environment, outside the lab, too open or malformed."""


def _inside(path: str, root: Path) -> bool:
    real, base = os.path.realpath(path).casefold(), os.path.realpath(root).casefold()
    return real == base or real.startswith(base.rstrip(os.sep) + os.sep)


def keyring_path() -> Path:
    raw = os.environ.get(ENV)
    if not raw:
        raise LabKeyringRefused(f"{ENV} is not set")
    if not _inside(raw, LAB_ROOT):
        raise LabKeyringRefused(f"{ENV} must point inside {LAB_ROOT}")
    return Path(os.path.realpath(raw))


def _load(path: Path) -> dict:
    try:
        st = path.stat()
    except FileNotFoundError:
        return {"format": FORMAT, "entries": {}}
    if not stat.S_ISREG(st.st_mode):
        raise LabKeyringRefused("the lab keyring is not a regular file")
    if st.st_mode & 0o077:
        raise LabKeyringRefused("the lab keyring file must not be readable by others (mode 0600)")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise LabKeyringRefused("the lab keyring file is not JSON") from None
    entries = doc.get("entries") if isinstance(doc, dict) else None
    if (
        not isinstance(doc, dict)
        or doc.get("format") != FORMAT
        or set(doc) != {"format", "entries"}
        or not isinstance(entries, dict)
        or not all(
            isinstance(accounts, dict) and all(isinstance(v, str) for v in accounts.values())
            for accounts in entries.values()
        )
    ):
        raise LabKeyringRefused("the lab keyring file is not in format 1")
    return doc


def _save(path: Path, doc: dict) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".keyring-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, sort_keys=True, separators=(",", ":"))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class FileKeyring(KeyringBackend):
    """``get_password`` / ``set_password`` / ``delete_password`` over the lab keyring file."""

    @properties.classproperty
    def priority(cls) -> float:
        keyring_path()  # raises: not viable for auto-detection unless the lab file is configured
        return 0.1

    def get_password(self, service: str, username: str) -> str | None:
        path = keyring_path()
        return _load(path)["entries"].get(service, {}).get(username)

    def set_password(self, service: str, username: str, password: str) -> None:
        path = keyring_path()
        doc = _load(path)
        doc["entries"].setdefault(service, {})[username] = password
        _save(path, doc)

    def delete_password(self, service: str, username: str) -> None:
        path = keyring_path()
        doc = _load(path)
        accounts = doc["entries"].get(service, {})
        if username not in accounts:
            raise PasswordDeleteError("no such entry")
        del accounts[username]
        if not accounts:
            del doc["entries"][service]
        _save(path, doc)
