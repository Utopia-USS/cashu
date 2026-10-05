"""Alert and watchlist MCP tools (investments module): thin adapters over
``modules.investments.service.{alerts,watchlist,views}``.

Read: ``alerts``, ``watchlist``. Write: ``add_alert`` (an ACTIVE alert with ``source = agent``, validated
against the catalog, at most 50 live agent alerts per profile), ``mute_alert``, ``add_to_watchlist``,
``remove_from_watchlist``. Every call is audited by the server (``mcp_calls``). Price levels of public
instruments and percentages are not personal amounts (label ``level`` / ``percent``, sent in both modes);
an owner-named instrument's name and symbol are identifiers and its levels stay ``amount``. Alerts are
conditions on hard data, never price predictions.
"""

from __future__ import annotations

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec
from .investments import owner_named, owner_named_ids
from .messages import custom_condition, custom_signal_message

_TEXT = {"type": "string", "maxLength": 2000}
_KINDS = [
    "price_above",
    "price_below",
    "change_pct",
    "drawdown_from_high",
    "new_high",
    "sma_cross",
    "weight_above",
    "weight_below",
    "custom",
]
_STATUS = ["all", "live", "active", "triggered", "snoozed", "muted", "expired"]


def _services():
    from finanse.modules.investments.service import alerts, views, watchlist

    return alerts, views, watchlist


def _instrument(inst: dict | None, owned: set[int]) -> dict:
    if not inst:
        return {"instrument_id": L.ref(None)}
    iid = inst.get("id") if isinstance(inst.get("id"), int) else None
    private = iid in owned or owner_named(
        inst.get("asset_class"), inst.get("valuation_mode"), inst.get("isin")
    )
    label = inst.get("label")
    return {
        "instrument_id": L.ref(iid),
        "symbol": L.identifier(inst.get("symbol")) if private else L.symbol(inst.get("symbol")),
        "isin": L.symbol(inst.get("isin")),
        "label": L.identifier(label) if private else L.text(label),
        "currency": L.category(inst.get("currency")),
        "owner_named": L.flag(private),
    }


def _price(value, private: bool) -> L.Labelled:
    return L.amount(value) if private else L.level(value)


def _params(ctx: ToolContext, kind: str, params: dict, private: bool) -> dict:
    out: dict = {}
    if "level" in params:
        out["level"] = _price(params.get("level"), private)
    if "threshold" in params:
        out["threshold"] = L.pct(params.get("threshold"))
    if "window_days" in params:
        out["window_days"] = L.count(params.get("window_days"))
    if "direction" in params:
        out["direction"] = L.category(params.get("direction"))
    if "bucket" in params:
        out["bucket"] = L.category(params.get("bucket"))
    if "expression" in params:
        out["expression"] = custom_condition(ctx, params.get("expression"), private=private)
    return out


def _alert(ctx: ToolContext, row: dict, owned: set[int]) -> dict:
    instrument = _instrument(row.get("instrument"), owned)
    private = bool(instrument.get("owner_named") and instrument["owner_named"].value)
    unit = row.get("unit")
    last = row.get("last_value")
    if unit == "price":
        last_value = _price(last, private)
    elif unit == "ratio":
        last_value = L.pct(last)
    else:
        last_value = L.pct(None)
    signal = row.get("signal")
    return {
        "alert_id": L.ref(row["id"]),
        "kind": L.category(row["kind"]),
        "scope": L.category(row["scope"]),
        "instrument": instrument,
        "params": _params(ctx, row["kind"], row.get("params") or {}, private),
        "unit": L.category(unit),
        "polarity": L.category(row["polarity"]),
        "severity": L.category(row["severity"]),
        "status": L.category(row["status"]),
        "source": L.category(row["source"]),
        "created_by": L.category(row["created_by"]),
        "title": L.text(row["title"]),
        "note": L.text(row.get("note")),
        "cooldown_days": L.count(row.get("cooldown_days")),
        "expires_at": L.date(row.get("expires_at")),
        "snoozed_until": L.date(row.get("snoozed_until")),
        "last_triggered_at": L.date(row.get("last_triggered_at")),
        "last_checked_at": L.date(row.get("last_checked_at")),
        "last_value": last_value,
        "created_at": L.date(row.get("created_at")),
        "signal": None
        if signal is None
        else {
            "signal_id": L.ref(signal.get("id")),
            "status": L.category(signal.get("status")),
            "message": custom_signal_message(
                ctx,
                signal.get("message"),
                (row.get("params") or {}).get("expression"),
                private=private,
            )
            if row["kind"] == "custom"
            else L.text(signal.get("message")),
        },
    }


def _limits(ctx: ToolContext) -> dict:
    from finanse.modules.investments.store import alerts as alert_store

    alerts, _views, _watch = _services()
    return {
        "agent_live": L.count(alert_store.live_agent_alerts(ctx.session, ctx.profile_id)),
        "agent_max": L.count(alerts.AGENT_ALERT_LIMIT),
    }


def alerts(ctx: ToolContext, status: str = "live") -> dict:
    alert_service, views, _watch = _services()
    try:
        statuses = alert_service.parse_status_filter(status)
    except alert_service.AlertError as e:
        raise ToolError(str(e)) from None
    owned = owner_named_ids(ctx)
    rows = views.alerts_view(ctx.session, ctx.profile, statuses)
    return {
        "alerts": [_alert(ctx, r, owned) for r in rows],
        "limits": _limits(ctx),
        "kinds": [L.category(k) for k in _KINDS],
        "note": L.text(
            "alerts are conditions on stored prices and weights, checked by the daily run; a "
            "triggered alert is a signal (rule alert:<id>) with the alert's polarity and severity; "
            "threshold and weights are fractions (0.1 = 10%), levels are in the instrument's currency"
        ),
    }


def add_alert(
    ctx: ToolContext,
    kind: str,
    params: dict,
    polarity: str,
    severity: str,
    title: str,
    instrument: str | None = None,
    note: str | None = None,
    expires_in_days: int | None = None,
    cooldown_days: int | None = None,
    scope: str | None = None,
) -> dict:
    alert_service, views, _watch = _services()
    from finanse.modules.investments.alerts import AlertSource

    try:
        instrument_id = (
            alert_service.find_instrument(ctx.session, ctx.profile, instrument)
            if instrument
            else None
        )
        row = alert_service.create(
            ctx.session,
            ctx.profile,
            alert_service.AlertInput(
                kind=kind,
                title=title,
                params=params,
                instrument_id=instrument_id,
                scope=scope,
                polarity=polarity,
                severity=severity,
                note=note,
                cooldown_days=cooldown_days,
                expires_in_days=expires_in_days,
            ),
            source=AlertSource.AGENT,
            created_by="mcp",
        )
    except alert_service.AlertNotFound as e:
        raise ToolError(str(e), "not_found") from None
    except alert_service.AlertLimit as e:
        raise ToolError(str(e), "limit") from None
    except alert_service.AlertError as e:
        raise ToolError(str(e)) from None
    return {
        "alert": _alert(
            ctx, views.one_alert(ctx.session, ctx.profile, row), owner_named_ids(ctx)
        ),
        "limits": _limits(ctx),
        "note": L.text(
            "created as active (source agent); the daily run checks it, the owner sees it badged in "
            "the app and can mute or delete it"
        ),
    }


def mute_alert(ctx: ToolContext, id: int) -> dict:
    alert_service, _views, _watch = _services()
    try:
        row = alert_service.mute(ctx.session, ctx.profile, id)
    except alert_service.AlertNotFound:
        raise ToolError("no such alert in this profile (see alerts)", "not_found") from None
    except alert_service.AlertError as e:
        raise ToolError(str(e)) from None
    return {"alert_id": L.ref(row.id), "status": L.category(row.status)}


def _watch_row(row: dict, owned: set[int]) -> dict:
    instrument = _instrument(row.get("instrument"), owned)
    private = bool(instrument["owner_named"].value) if "owner_named" in instrument else False
    price = row.get("price") or {}
    nearest = (row.get("alerts") or {}).get("nearest")
    return {
        "item_id": L.ref(row["id"]),
        "instrument": instrument,
        "note": L.text(row.get("note")),
        "tags": [L.category(t) for t in row.get("tags") or []],
        "source": L.category(row.get("source")),
        "added_at": L.date(row.get("added_at")),
        "held": L.flag(bool(row.get("held"))),
        "price_source": L.flag(bool(row.get("price_source"))),
        "last_close": _price(price.get("close"), private),
        "price_date": L.date(price.get("date")),
        "stale": L.flag(price.get("stale")),
        "change_1d": L.pct(price.get("change_1d")),
        "change_1m": L.pct(price.get("change_1m")),
        "high_52w": _price(price.get("high_52w"), private),
        "from_high_52w": L.pct(price.get("from_high_52w")),
        "alerts": {
            "count": L.count((row.get("alerts") or {}).get("count")),
            "live": L.count((row.get("alerts") or {}).get("live")),
            "triggered": L.count((row.get("alerts") or {}).get("triggered")),
            "nearest": None
            if not nearest
            else {
                "alert_id": L.ref(nearest.get("alert_id")),
                "kind": L.category(nearest.get("kind")),
                "level": _price(nearest.get("level"), private),
                "distance_pct": L.pct(nearest.get("distance_pct")),
            },
        },
    }


def watchlist(ctx: ToolContext) -> dict:
    _alerts, views, _watch = _services()
    owned = owner_named_ids(ctx)
    return {
        "items": [_watch_row(r, owned) for r in views.watchlist_view(ctx.session, ctx.profile)],
        "note": L.text(
            "watched instruments join the daily price refresh; changes and distances are fractions "
            "(0.05 = 5%) from stored closes, never forecasts"
        ),
    }


def add_to_watchlist(
    ctx: ToolContext,
    symbol_or_isin: str,
    note: str | None = None,
    name: str | None = None,
    currency: str | None = None,
    exchange: str | None = None,
) -> dict:
    _alerts, views, watch = _services()
    from finanse.modules.investments.alerts import AlertSource

    try:
        result = watch.add(
            ctx.session,
            ctx.profile,
            symbol_or_isin,
            name=name,
            currency=currency,
            exchange=exchange,
            note=note,
            source=AlertSource.AGENT,
        )
    except watch.WatchlistConflict as e:
        raise ToolError(str(e), "conflict") from None
    except watch.WatchlistNotFound as e:
        raise ToolError(str(e), "not_found") from None
    except watch.WatchlistError as e:
        raise ToolError(str(e)) from None
    owned = owner_named_ids(ctx)
    row = next(
        r for r in views.watchlist_view(ctx.session, ctx.profile) if r["id"] == result.item.id
    )
    return {
        "item": _watch_row(row, owned),
        "created_instrument": L.flag(result.created_instrument),
        "warnings": [L.text(w) for w in result.warnings],
    }


def remove_from_watchlist(ctx: ToolContext, id: int) -> dict:
    _alerts, _views, watch = _services()
    try:
        item = watch.remove(ctx.session, ctx.profile, id)
    except watch.WatchlistNotFound:
        raise ToolError(
            "no such watchlist item in this profile (see watchlist)", "not_found"
        ) from None
    return {"item_id": L.ref(item.id), "removed": L.flag(True)}


TOOLS = (
    ToolSpec(
        "alerts",
        "investments",
        "The profile's alerts (status: live = active, triggered or snoozed (default), all, or one "
        "status) with params, polarity, severity, last check and the open signal; plus the agent "
        "alert limit.",
        alerts,
        properties={"status": {"type": "string", "enum": _STATUS, "default": "live"}},
    ),
    ToolSpec(
        "add_alert",
        "investments",
        "Create an ACTIVE alert (source agent) from the fixed catalog: price_above / price_below "
        "{level}, change_pct {window_days, threshold, direction up|down|any}, drawdown_from_high "
        "{window_days, threshold}, new_high {window_days}, sma_cross {window_days, direction "
        "above|below}, weight_above / weight_below {threshold, bucket?}, custom {expression, "
        "bucket?}. instrument: id, symbol, ISIN or Yahoo symbol of a held or watched instrument "
        "(add_to_watchlist first). Thresholds are fractions (0.1 = 10%), window_days counts "
        "sessions. At most 50 live agent alerts per profile. Conditions on hard data only.",
        add_alert,
        properties={
            "kind": {"type": "string", "enum": _KINDS},
            "params": {"type": "object"},
            "instrument": {"type": "string", "maxLength": 40},
            "polarity": {"type": "string", "enum": ["positive", "negative", "neutral"]},
            "severity": {"type": "string", "enum": ["info", "action"]},
            "title": {"type": "string", "maxLength": 120},
            "note": _TEXT,
            "expires_in_days": {"type": "integer", "minimum": 1, "maximum": 3650},
            "cooldown_days": {"type": "integer", "minimum": 0, "maximum": 3650},
            "scope": {"type": "string", "enum": ["instrument", "portfolio", "bucket"]},
        },
        required=("kind", "params", "polarity", "severity", "title"),
        write=True,
    ),
    ToolSpec(
        "mute_alert",
        "investments",
        "Mute an alert (any source): it stops being checked and its open signal closes; the owner "
        "can re-arm it in the app.",
        mute_alert,
        properties={"id": {"type": "integer", "minimum": 1}},
        required=("id",),
        write=True,
    ),
    ToolSpec(
        "watchlist",
        "investments",
        "Watched instruments (not necessarily held): last close, 1-day / 1-month change, 52-week "
        "high and distance, alerts count and the nearest alert level.",
        watchlist,
    ),
    ToolSpec(
        "add_to_watchlist",
        "investments",
        "Watch an instrument by ticker with its market (VWCE.DE, PKN.WA, AAPL.US, NVDA:XNAS) or ISIN; "
        "a new instrument gets a guessed Yahoo symbol (exchange / currency help when the market is "
        "unknown). It joins the daily price refresh.",
        add_to_watchlist,
        properties={
            "symbol_or_isin": {"type": "string", "maxLength": 40},
            "note": {"type": "string", "maxLength": 1000},
            "name": {"type": "string", "maxLength": 120},
            "currency": {"type": "string", "maxLength": 3},
            "exchange": {"type": "string", "maxLength": 20},
        },
        required=("symbol_or_isin",),
        write=True,
    ),
    ToolSpec(
        "remove_from_watchlist",
        "investments",
        "Stop watching an instrument (item id from watchlist); its alerts stay.",
        remove_from_watchlist,
        properties={"id": {"type": "integer", "minimum": 1}},
        required=("id",),
        write=True,
    ),
)
