"""Secrets in the OS keychain via ``keyring`` (macOS Keychain, Windows Credential
Manager, Secret Service on Linux).

``cashu secrets set|get|delete <name>`` manages them; settings read the keychain
first and fall back to environment variables (CI / development). Never log or
print a secret value: use ``mask()`` for a safe preview.

Connector secrets (F10) live in their own validated namespace ``connector/<connector id>/<profile
slug>/<binding id>/<secret id>``: they are not in ``KNOWN`` (the owner never manages them by name), they
are set only from the app's write-only endpoint or ``cashu connectors secret set`` (hidden prompt), and
they reach a connector only on its stdin. Deleting a binding or a connector deletes its secrets.
"""

from __future__ import annotations

import logging
import re

SERVICE = "cashu"
LEGACY_SERVICE = "finanse"  # legacy name: the keychain service before the rename
ANTHROPIC = "anthropic"

# name -> what it is (shown in the CLI help)
KNOWN: dict[str, str] = {
    ANTHROPIC: "Anthropic API key for the `anthropic` categorization backend",
}

log = logging.getLogger(__name__)


class SecretsError(RuntimeError):
    """The keychain is unavailable or refused the operation."""


def _check(name: str) -> None:
    if name not in KNOWN:
        raise ValueError(f"unknown secret {name!r} (known: {', '.join(sorted(KNOWN))})")


def get_secret(name: str) -> str | None:
    """The stored value, or None when unset or when no keychain is available."""
    import keyring
    from keyring.errors import KeyringError

    _check(name)
    try:
        return keyring.get_password(SERVICE, name) or _adopt_legacy(name)
    except KeyringError as e:  # no backend / locked keychain: callers fall back to env
        log.debug("keychain unavailable for %s: %s", name, type(e).__name__)
        return None


def set_secret(name: str, value: str) -> None:
    import keyring
    from keyring.errors import KeyringError

    _check(name)
    if not value:
        raise ValueError("empty secret")
    try:
        keyring.set_password(SERVICE, name, value)
    except KeyringError as e:
        raise SecretsError(f"could not store {name!r} in the keychain: {type(e).__name__}") from None


def delete_secret(name: str) -> bool:
    """Remove the secret; False when it was not stored."""
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError

    _check(name)
    legacy = _delete_legacy(name)
    try:
        keyring.delete_password(SERVICE, name)
    except PasswordDeleteError:
        return legacy
    except KeyringError as e:
        raise SecretsError(f"could not delete {name!r}: {type(e).__name__}") from None
    return True


# --------------------------------------------------------------------------- #
# Secrets stored before the rename (service "finanse", legacy name)
# --------------------------------------------------------------------------- #


def _adopt_legacy(name: str) -> str | None:
    """A secret still stored under the pre-rename service: copied to ``SERVICE`` and removed from the
    old one (a failed copy keeps the old entry and still returns the value)."""
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError

    value = keyring.get_password(LEGACY_SERVICE, name)
    if not value:
        return None
    try:
        keyring.set_password(SERVICE, name, value)
    except KeyringError as e:
        log.debug("could not move a keychain entry to %s: %s", SERVICE, type(e).__name__)
        return value
    try:
        keyring.delete_password(LEGACY_SERVICE, name)
    except (PasswordDeleteError, KeyringError):
        pass
    log.info("moved a keychain entry from service %s to %s", LEGACY_SERVICE, SERVICE)
    return value


def _delete_legacy(name: str) -> bool:
    """Remove the pre-rename entry too, so a deleted secret is not adopted again later."""
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError

    try:
        keyring.delete_password(LEGACY_SERVICE, name)
    except (PasswordDeleteError, KeyringError):
        return False
    return True


# --------------------------------------------------------------------------- #
# Connector secrets (namespaced, never in KNOWN)
# --------------------------------------------------------------------------- #

CONNECTOR_PREFIX = "connector/"
_CONNECTOR_ID = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SECRET_ID = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def connector_secret_name(
    connector_id: str, profile_slug: str, binding_id: int, secret_id: str
) -> str:
    """Keychain account name of one connector secret; raises ``ValueError`` for a malformed part."""
    if not _CONNECTOR_ID.match(connector_id or ""):
        raise ValueError("bad connector id")
    if not _SLUG.match(profile_slug or ""):
        raise ValueError("bad profile slug")
    if isinstance(binding_id, bool) or not isinstance(binding_id, int) or binding_id <= 0:
        raise ValueError("bad binding id")
    if not _SECRET_ID.match(secret_id or ""):
        raise ValueError("bad secret id")
    return f"{CONNECTOR_PREFIX}{connector_id}/{profile_slug}/{binding_id}/{secret_id}"


def _check_connector(name: str) -> None:
    parts = name.removeprefix(CONNECTOR_PREFIX).split("/") if name.startswith(CONNECTOR_PREFIX) else []
    if len(parts) != 4 or not parts[2].isdigit():
        raise ValueError("not a connector secret name")
    connector_secret_name(parts[0], parts[1], int(parts[2]), parts[3])


def get_connector_secret(name: str) -> str | None:
    """The stored value, or None when unset or when no keychain is available."""
    import keyring
    from keyring.errors import KeyringError

    _check_connector(name)
    try:
        return keyring.get_password(SERVICE, name) or _adopt_legacy(name)
    except KeyringError as e:
        log.debug("keychain unavailable for a connector secret: %s", type(e).__name__)
        return None


def set_connector_secret(name: str, value: str) -> None:
    import keyring
    from keyring.errors import KeyringError

    _check_connector(name)
    if not value:
        raise ValueError("empty secret")
    try:
        keyring.set_password(SERVICE, name, value)
    except KeyringError as e:
        raise SecretsError(f"could not store a connector secret: {type(e).__name__}") from None


def delete_connector_secret(name: str) -> bool:
    """Remove the secret; False when it was not stored."""
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError

    _check_connector(name)
    legacy = _delete_legacy(name)
    try:
        keyring.delete_password(SERVICE, name)
    except PasswordDeleteError:
        return legacy
    except KeyringError as e:
        raise SecretsError(f"could not delete a connector secret: {type(e).__name__}") from None
    return True


def backend_name() -> str:
    import keyring

    backend = keyring.get_keyring()
    return f"{type(backend).__module__}.{type(backend).__name__}"


def mask(value: str | None) -> str:
    """Safe preview: the first 3 and last 4 characters of a long value, else stars."""
    if not value:
        return "-"
    if len(value) < 16:
        return "*" * 8
    return f"{value[:3]}...{value[-4:]}"
