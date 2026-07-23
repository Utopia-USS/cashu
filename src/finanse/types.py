"""Custom SQLAlchemy column types.

Money is stored as exact decimal text (never float) so summation is precise.
We aggregate in Python over Decimal values rather than relying on SQLite's
lossy numeric handling.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import String, TypeDecorator


class DecimalText(TypeDecorator):
    """Store a Decimal as its exact string representation (TEXT column)."""

    impl = String
    cache_ok = True

    def process_bind_param(self, value, dialect):  # Python -> DB
        if value is None:
            return None
        return str(Decimal(str(value)))

    def process_result_value(self, value, dialect):  # DB -> Python
        if value is None:
            return None
        return Decimal(value)
