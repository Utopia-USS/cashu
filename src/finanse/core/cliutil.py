"""Shared CLI output helpers (one console for every module's commands, so tests
and callers can redirect all output in one place)."""

from __future__ import annotations

from decimal import Decimal

from rich.console import Console

console = Console()
err_console = Console(stderr=True)


def fmt(amount: Decimal | None, currency: str = "PLN") -> str:
    if amount is None:
        return "—"
    q = Decimal(amount).quantize(Decimal("0.01"))
    s = f"{q:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} {currency}"
