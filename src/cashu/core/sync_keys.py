"""Gids for the sync outbox (S30): the per-vault gid salt from the OS keychain, keyed DET gids and ULIDs.

TRANSITIONAL(S49): the Python side computes gids only while it is a writer next to the TS store.

The contract with the TS side (``packages/store/spec/gid.md`` 3, events.md 11):

- **Where the salt lives**: the OS keychain through ``keyring``, service ``cashu`` (the app's keychain
  service, ``core/secrets.py``), account ``cashu.vault.<vault id>.gidsalt``, the password = the 32 salt
  bytes as 64 lower-case hex. The name follows the S27 key store naming (``cashu.vault.<id>.keys``,
  ``[A-Za-z0-9._-]``). The desktop that creates or pairs the vault writes the entry (S29 / S48); Python
  only reads it. Never in a file of the data dir, never logged, never sent to the MCP agent.
- **Which vault a profile is**: ``sync_vaults`` (``cashu sync link``), the 32 lower-case hex S27 vault
  id. The salt is looked up by that id, never derived from the slug or any other public value.
- **gid**: ``uuid8(HMAC-SHA256(salt, "cashu.gid.v1/" + table + US + part1 + US + ...))``, the vectors of
  gid.md section 8 pin it (``tests/test_sync_outbox.py``).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets as _random
import threading
import time
from collections.abc import Sequence

from . import secrets

KEYRING_SERVICE = secrets.SERVICE
GID_DOMAIN_PREFIX = "cashu.gid.v1/"
UNIT_SEPARATOR = "\x1f"
SALT_BYTES = 32
VAULT_ID = re.compile(r"^[0-9a-f]{32}$")
_SALT_HEX = re.compile(r"^[0-9a-f]{64}$")
# gid.md 3.2 (packages/store/src/events/v1/namespaces.ts GID_TABLES): never rename or reuse a domain.
GID_TABLES = frozenset(
    {
        "profile_modules",
        "accounts",
        "balances",
        "transactions",
        "category_rules",
        "loans",
        "depreciations",
        "asset_details",
        "budget_settings",
        "inv_account_settings",
        "inv_transactions",
        "inv_position_snapshots",
        "inv_instrument_renames",
        "inv_manual_valuations",
        "inv_instruments",
        "inv_instrument_aliases",
        "inv_profile_instruments",
        "inv_topic_theses",
        "watchlist_items",
        "connector_bindings",
        "genesis",
    }
)
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

log = logging.getLogger(__name__)
_cache: dict[str, Salt | None] = {}
_cache_lock = threading.Lock()


class Salt:
    """The 32-byte gid salt of one vault; prints redacted."""

    __slots__ = ("_bytes",)

    def __init__(self, value: bytes) -> None:
        if len(value) != SALT_BYTES:
            raise ValueError("a gid salt is 32 bytes")
        self._bytes = bytes(value)

    def expose(self) -> bytes:
        return self._bytes

    def __repr__(self) -> str:
        return "Salt([redacted])"

    __str__ = __repr__


def salt_entry_name(vault_id: str) -> str:
    """The keychain account name of a vault's gid salt."""
    if not VAULT_ID.match(vault_id or ""):
        raise ValueError("bad vault id")
    return f"cashu.vault.{vault_id}.gidsalt"


def gid_salt(vault_id: str) -> Salt | None:
    """The vault's salt from the keychain (cached for the process), None when it is not stored, the
    keychain is unavailable or the entry is malformed (logged without the value)."""
    import keyring
    from keyring.errors import KeyringError

    name = salt_entry_name(vault_id)
    with _cache_lock:
        if vault_id in _cache:
            return _cache[vault_id]
    try:
        raw = keyring.get_password(KEYRING_SERVICE, name)
    except KeyringError as e:
        log.debug("keychain unavailable for a gid salt: %s", type(e).__name__)
        return None  # not cached: the keychain may unlock later
    salt = None
    if raw is not None:
        if _SALT_HEX.match(raw):
            salt = Salt(bytes.fromhex(raw))
        else:
            log.warning("the gid salt entry of a vault is malformed; DET gids are left to the shipper")
    with _cache_lock:
        _cache[vault_id] = salt
    return salt


def forget_cached_salts() -> None:
    """Drop the process cache (tests, and after ``cashu sync link`` changes a profile's vault)."""
    with _cache_lock:
        _cache.clear()


def det_gid(salt: Salt, table: str, parts: Sequence[str]) -> str:
    """The keyed DET gid (gid.md 3): a lower-case RFC 9562 version 8 UUID."""
    if table not in GID_TABLES:
        raise ValueError(f"unknown gid domain {table!r}")
    for part in parts:
        if UNIT_SEPARATOR in part:
            raise ValueError("a gid part must not contain U+001F")
    msg = GID_DOMAIN_PREFIX + table + "".join(UNIT_SEPARATOR + p for p in parts)
    d = bytearray(hmac.new(salt.expose(), msg.encode("utf-8"), hashlib.sha256).digest()[:16])
    d[6] = (d[6] & 0x0F) | 0x80
    d[8] = (d[8] & 0x3F) | 0x80
    h = d.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def mint_ulid(now_ms: int | None = None) -> str:
    """A new ULID (26 Crockford base32 characters, upper case): 48-bit ms time + 80 random bits."""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    if not 0 <= ms < 1 << 48:
        raise ValueError("ULID time out of range")
    value = (ms << 80) | _random.randbits(80)
    return "".join(_CROCKFORD[(value >> (5 * i)) & 31] for i in range(25, -1, -1))
