"""In-memory keyring for the e2e server (PYTHON_KEYRING_BACKEND=memory_keyring.MemoryKeyring, set by
global-setup.ts): a connector binding's secret typed in the app never reaches the developer's macOS keychain."""

from __future__ import annotations

from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError


class MemoryKeyring(KeyringBackend):
    priority = 1  # only ever selected explicitly through the environment

    def __init__(self) -> None:
        super().__init__()
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self._store.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if self._store.pop((service, username), None) is None:
            raise PasswordDeleteError("not set")
