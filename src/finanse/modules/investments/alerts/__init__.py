"""Dynamic alerts: a fixed catalog of conditions on hard data (``catalog``) and their pure evaluation
(``evaluate``). Persistence is in ``store.alerts``, orchestration in ``service.alerts``; a triggered
alert becomes a signal that follows the rule-signal lifecycle and notification policy."""

from __future__ import annotations

from .catalog import (
    CATALOG,
    EVALUATED_STATUSES,
    KINDS,
    LIVE_STATUSES,
    MAX_WINDOW_DAYS,
    PRICE_KINDS,
    WEIGHT_KINDS,
    AlertKind,
    AlertScope,
    AlertSource,
    AlertStatus,
    AlertValidationError,
    ValidatedAlert,
    catalog_dicts,
    validate,
    validate_text,
)
from .evaluate import (
    ALERT_PREFIX,
    AlertCheck,
    AlertData,
    AlertDefinition,
    alert_id_of,
    alert_rule_id,
    alert_signal_kind,
    evaluate_alert,
    is_alert_key,
)

__all__ = [
    "ALERT_PREFIX",
    "CATALOG",
    "EVALUATED_STATUSES",
    "KINDS",
    "LIVE_STATUSES",
    "MAX_WINDOW_DAYS",
    "PRICE_KINDS",
    "WEIGHT_KINDS",
    "AlertCheck",
    "AlertData",
    "AlertDefinition",
    "AlertKind",
    "AlertScope",
    "AlertSource",
    "AlertStatus",
    "AlertValidationError",
    "ValidatedAlert",
    "alert_id_of",
    "alert_rule_id",
    "alert_signal_kind",
    "catalog_dicts",
    "evaluate_alert",
    "is_alert_key",
    "validate",
    "validate_text",
]
