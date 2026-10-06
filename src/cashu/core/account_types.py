"""Account type registry: what each kind of account means for net worth.

Every module registers the account types it owns (through its ``ModuleSpec``)
with their net-worth semantics, instead of one shared enum with
module-specific meaning spread over the code:

- ``sign``: ``asset`` (adds at face value), ``liability`` (stored as the
  outstanding amount, subtracts) or ``credit`` (a credit card: a positive balance
  is available credit and counts 0, only a negative balance is debt);
- ``liquid``: counts toward "liquid" net worth;
- ``bucket``: the net-worth chart bucket it stacks into (see ``NetWorthBucket``);
- ``label``: Polish display label (UI data).

Ids are the stored ``accounts.type`` values (the upstream enum values stay valid).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Literal

Sign = Literal["asset", "liability", "credit"]


@dataclass(frozen=True)
class AccountTypeInfo:
    id: str
    module: str  # owner module id ("core" for the fallback)
    label: str
    sign: Sign = "asset"
    liquid: bool = True
    bucket: str = "money"


@dataclass(frozen=True)
class NetWorthBucket:
    """A net-worth chart bucket; buckets of all accounts sum to the total."""

    id: str
    label: str  # Polish display label (UI data)
    order: int  # stacking order: assets bottom-up, then liabilities
    liability: bool = False


_TYPES: dict[str, AccountTypeInfo] = {}
_BUCKETS: dict[str, NetWorthBucket] = {}

# Everything liquid that no module claims a special bucket for.
MONEY = NetWorthBucket("money", "Pieniądze", 0)


def type_id(value: object) -> str:
    """The registry id of an account type value (enum member or plain string)."""
    return str(value.value if isinstance(value, enum.Enum) else value)


def register_type(info: AccountTypeInfo) -> None:
    current = _TYPES.get(info.id)
    if current is not None and current != info:
        raise ValueError(f"Account type {info.id!r} is already registered by {current.module!r}")
    _TYPES[info.id] = info


def register_bucket(bucket: NetWorthBucket) -> None:
    current = _BUCKETS.get(bucket.id)
    if current is not None and current != bucket:
        raise ValueError(f"Net-worth bucket {bucket.id!r} is already registered")
    _BUCKETS[bucket.id] = bucket


def get(value: object) -> AccountTypeInfo:
    """Metadata of an account type; an unknown id is a liquid asset in "money"."""
    tid = type_id(value)
    return _TYPES.get(tid) or AccountTypeInfo(tid, "core", tid)


def all_types() -> list[AccountTypeInfo]:
    return list(_TYPES.values())


def ids() -> list[str]:
    return list(_TYPES)


def buckets() -> list[NetWorthBucket]:
    return sorted(_BUCKETS.values(), key=lambda b: b.order)


def bucket(bucket_id: str) -> NetWorthBucket:
    return _BUCKETS.get(bucket_id) or NetWorthBucket(bucket_id, bucket_id, 999)


register_bucket(MONEY)
