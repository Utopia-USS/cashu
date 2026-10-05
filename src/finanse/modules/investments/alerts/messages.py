"""Stable code + params of an alert signal's message, so a UI can show it in its own language.

The Polish ``message`` (``"<title>: <detail>"``, ``evaluate.py``) stays as is; ``alert_message`` maps
the fired signal's stored payload to ``("alert.<kind>", params)``. Params are the measured facts of
the payload (prices as decimal text, ratios as fractions, ISO dates) plus ``title`` and the
instrument ``label``; nothing is computed here. Pure: no IO.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .evaluate import alert_signal_kind

_PREFIX = alert_signal_kind("")  # "alert:"

# Payload keys copied into the params per alert kind (``price_date`` is renamed to ``date``).
_KEYS: dict[str, tuple[str, ...]] = {
    "price_above": ("close", "level", "currency", "price_date"),
    "price_below": ("close", "level", "currency", "price_date"),
    "change_pct": ("window_days", "from_close", "from_date", "close", "price_date", "threshold"),
    "drawdown_from_high": (
        "drawdown",
        "threshold",
        "window_days",
        "close",
        "price_date",
        "high",
        "high_date",
    ),
    "new_high": ("close", "price_date", "window_days", "previous_high"),
    "sma_cross": ("close", "price_date", "direction", "window_days", "sma"),
    "weight_above": ("weight", "threshold", "bucket_id", "held"),
    "weight_below": ("weight", "threshold", "bucket_id", "held"),
}


def alert_message(
    signal_kind: str, payload: Mapping[str, Any] | None, message: str, label: str | None = None
) -> tuple[str | None, dict | None]:
    """``(code, params)`` of an alert signal (``kind = "alert:<kind>"``), ``(None, None)`` for any
    other signal. ``change_pct`` adds ``direction`` (up | down, from the sign) and ``change`` (its
    absolute size); weight kinds add ``subject`` (bucket | instrument); ``custom`` carries the
    rule engine's ``detail`` (Polish, ``Warunek spełniony: <when> (<values>).``)."""
    if not signal_kind.startswith(_PREFIX):
        return None, None
    kind = signal_kind.removeprefix(_PREFIX)
    data = dict(payload or {})
    title = data.get("title")
    params: dict[str, Any] = {"title": title, "label": label or data.get("symbol")}
    for key in _KEYS.get(kind, ()):
        if key in data:
            params["date" if key == "price_date" else key] = data[key]
    if kind == "change_pct" and isinstance(data.get("change"), int | float):
        change = float(data["change"])
        params["direction"] = "up" if change > 0 else "down"
        params["change"] = abs(change)
    elif kind in ("weight_above", "weight_below"):
        params["subject"] = "bucket" if data.get("bucket_id") else "instrument"
    elif kind == "custom" or kind not in _KEYS:
        prefix = f"{title}: " if title else ""
        params["detail"] = message.removeprefix(prefix) if prefix else message
    return f"alert.{kind}", params
