"""Research MCP tools (investments module): the weekly research routine (``market-research`` skill)
reads its context and writes runs and notes through these thin adapters over
``modules.investments.research``.

Read: ``research_context`` (held and watched instruments with weights, theses (entry type,
invalidation, exit plan), thesis health and sentiment, the strategy's candidate criteria, dismissed
candidates in cooldown, known upcoming events, the last run, limits), ``research_notes(since?)``.
Write: ``start_research_run(scope)``, ``add_research_note(...)`` (schema-validated: sources with URL,
publisher and date required, bounded lengths, no amounts / targets / sizes, no recommendation or price
prediction, no paywall-bypass links), ``finish_research_run(run_id, ...)``.

Privacy: owner-named instruments (claims, private loans) and cash are never researched (not listed,
refused as a note's instrument). Free text (titles, summaries, theses, themes, source fields) is a
``text`` label: identifiers are always scrubbed and money amounts in strict mode, like every text
field. Weights and sentiment scores are fractions (``percent``); candidate-criteria thresholds are
screening parameters about public companies (``level``), never personal amounts.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec
from .investments import owner_named_ids, public_label

_KINDS = ["news", "earnings", "community", "trend", "macro", "candidate"]
_RELATIONS = ["supports", "weakens", "invalidates", "neutral", "none"]
_FIELDS = ["entry_type", "thesis", "invalidation", "exit_plan", "size_plan"]
BOUNDARIES = (
    (
        "facts and sentiment with sources and dates only; no buy / sell recommendation, no price "
        "prediction, no price target, no analyst ratings"
    ),
    "never bypass paywalls or bot protection; cite the original publisher's URL",
    "community sentiment (Reddit, X, forums) is noisy: kind community, strength counts as 1",
    (
        "a note invalidating a thesis becomes an action signal, strength 3 an info signal (one per "
        "instrument or theme and week); candidates never become signals"
    ),
    "summaries in Polish, numbers as facts with their source; no personal amounts or sizes",
)


def _research():
    from finanse.modules.investments.research import service, validation, views

    return service, validation, views


def _errors(error: Exception) -> ToolError:
    service, _validation, _views = _research()
    if isinstance(error, service.ResearchNotFound):
        return ToolError(str(error), "not_found")
    if isinstance(error, service.ResearchConflict):
        return ToolError(str(error), "conflict")
    return ToolError(str(error))


def _instrument(inst: dict | None, owned: set[int], ctx: ToolContext | None = None) -> dict:
    if not inst:
        return {"instrument_id": L.ref(None)}
    iid = inst.get("id") if isinstance(inst.get("id"), int) else None
    private = iid in owned
    return {
        "instrument_id": L.ref(iid),
        "symbol": L.identifier(inst.get("symbol")) if private else L.symbol(inst.get("symbol")),
        "isin": L.symbol(inst.get("isin")),
        "name": L.identifier(inst.get("name"))
        if private
        else L.text(public_label(ctx, inst.get("name"))),
        "asset_class": L.category(inst.get("asset_class")),
        "currency": L.category(inst.get("currency")),
    }


def _thesis(row) -> dict | None:
    if row is None:
        return None
    return {
        "thesis_id": L.ref(row.id),
        "entry_type": L.category(row.entry_type),
        "thesis": L.text(row.thesis),
        "invalidation": L.text(row.invalidation),
        "exit_plan": L.text(row.exit_plan),
        "size_plan": L.text(row.size_plan),
        "draft": L.flag(row.reviewed_at is None and row.thesis.startswith("Szkic z researchu: ")),
        "updated_at": L.date(row.updated_at),
    }


def _research_fields(item: dict | None) -> dict:
    item = item or {}
    counts = item.get("counts") or {}
    return {
        "health": L.category(item.get("health")),
        "counts": {k: L.count(counts.get(k)) for k in counts},
        "sentiment_8w": [L.pct(v) for v in item.get("sentiment_8w") or []],
        "direction": L.category(item.get("direction")),
        "last_researched_at": L.date(item.get("last_researched_at")),
    }


def _note(row: dict, owned: set[int], ctx: ToolContext | None = None) -> dict:
    details = row.get("details") or {}
    candidate = row.get("candidate")
    inst = row.get("instrument")
    return {
        "note_id": L.ref(row["id"]),
        "run_id": L.ref(row.get("run_id")),
        "kind": L.category(row["kind"]),
        "polarity": L.category(row["polarity"]),
        "strength": L.count(row["strength"]),
        "thesis_relation": L.category(row["thesis_relation"]),
        "thesis_field": L.category(row.get("thesis_field")),
        "title": L.text(row["title"]),
        "summary": L.text(row["summary"]),
        "instrument": _instrument(inst, owned, ctx) if inst else None,
        "theme": L.text(row.get("theme")),
        "candidate": None
        if candidate is None
        else {
            "symbol": L.symbol(candidate.get("symbol")),
            "key": L.symbol(candidate.get("key")),
            "name": L.text(candidate.get("name")),
            "accepted": L.flag(bool(candidate.get("accepted_at"))),
            "cooldown_until": L.date(row.get("cooldown_until")),
        },
        "details": None
        if not details
        else {
            "entry_type": L.category(details.get("entry_type")),
            "criteria": [
                {
                    "text": L.text(c.get("text")),
                    "met": L.flag(bool(c.get("met"))),
                    "threshold": L.text(c.get("threshold")),
                }
                for c in details.get("criteria") or []
            ],
            "context": L.text(details.get("context")),
            "bucket": L.category(details.get("bucket")),
            "scale": L.category(details.get("scale")),
            "event": L.text(details.get("event")),
            "event_date": L.date(details.get("event_date")),
        },
        "sources": [
            {
                "publisher": L.text(s.get("publisher")),
                "title": L.text(s.get("title")),
                "url": L.text(s.get("url")),
                "published_at": L.date(s.get("published_at")),
            }
            for s in row.get("sources") or []
        ],
        "signal_id": L.ref(row.get("signal_id")),
        "observed_at": L.date(row.get("observed_at")),
        "expires_at": L.date(row.get("expires_at")),
        "expired": L.flag(bool(row.get("expired"))),
        "dismissed": L.flag(bool(row.get("dismissed"))),
        "dismissed_at": L.date(row.get("dismissed_at")),
        "created_at": L.date(row.get("created_at")),
    }


def _run(run: dict | None) -> dict | None:
    if not run:
        return None
    counts = run.get("counts") or {}
    return {
        "run_id": L.ref(run["id"]),
        "status": L.category(run["status"]),
        "interrupted": L.flag(bool(run.get("interrupted"))),
        "scheduled": L.flag(bool(run.get("scheduled"))),
        "started_at": L.date(run.get("started_at")),
        "finished_at": L.date(run.get("finished_at")),
        "notes": L.count(run.get("notes")),
        "signals": L.count(run.get("signals")),
        "candidates": L.count(counts.get("candidates")),
    }


def _entry_types_in_use(theses: dict[int, Any], ids: set[int]) -> list[dict]:
    used: dict[str, int] = {}
    for iid, row in theses.items():
        if iid in ids:
            used[row.entry_type] = used.get(row.entry_type, 0) + 1
    return [{"entry_type": L.category(k), "theses": L.count(v)} for k, v in sorted(used.items())]


def _buckets(config) -> list[dict]:
    """The strategy's buckets with their match criteria (asset classes, tags, markets, currencies;
    the schema has no region criterion) and target weights."""
    if config is None:
        return []
    targets = config.allocation.targets
    return [
        {
            "bucket": L.category(b.id),
            "target": L.pct(targets.get(b.id)),
            "asset_classes": [L.category(a.value) for a in sorted(b.match.asset_classes)],
            "tags": [L.category(t) for t in sorted(b.match.tags)],
            "markets": [L.category(m) for m in sorted(b.match.mics)],
            "currencies": [L.category(str(c)) for c in sorted(b.match.currencies, key=str)],
            "pinned_instruments": L.count(len(b.match.instrument_ids)),
        }
        for b in config.allocation.buckets
    ]


def _sections(ctx: ToolContext, st) -> list[dict]:
    """strategy.md sections about beliefs, entry / exit rules and what the owner avoids, as text
    (identifiers always scrubbed, amounts in strict mode by the redactor)."""
    from finanse.modules.investments.research.strategy_text import strategy_sections
    from finanse.modules.investments.service import strategy as strategy_files

    markdown = st.config.markdown if st.config is not None else None
    if markdown is None:
        try:
            markdown = strategy_files.read_files(ctx.profile.slug)[1]
        except ValueError:
            markdown = None
    return [
        {"section": L.category(x.kind), "heading": L.text(x.heading), "text": L.text(x.text)}
        for x in strategy_sections(markdown)
    ]


def _exposure(positions: list[dict], owned: set[int]) -> dict:
    """Weights of the held positions by asset class, region and sector (fractions of the portfolio
    total; unclassified when the instrument has no value)."""
    groups: dict[str, dict[str, float]] = {"asset_class": {}, "region": {}, "sector": {}}
    for p in positions:
        inst = p.get("instrument") or {}
        weight = p.get("weight")
        if weight is None:
            continue
        for key, bucket in groups.items():
            value = inst.get(key) if inst.get("id") not in owned or key == "asset_class" else None
            name = value or "unclassified"
            bucket[name] = bucket.get(name, 0.0) + float(weight)
    return {
        f"{key}s" if key != "asset_class" else "asset_classes": [
            {key: L.category(name), "weight": L.pct(w)}
            for name, w in sorted(bucket.items(), key=lambda kv: -kv[1])
        ]
        for key, bucket in groups.items()
    }


# --------------------------------------------------------------------------- #
# Read tools
# --------------------------------------------------------------------------- #


def research_context(ctx: ToolContext) -> dict:
    from sqlmodel import select

    from finanse.modules.investments.models import THESIS_ENTRY_TYPES, InvResearchNote
    from finanse.modules.investments.service import strategy as strategy_files
    from finanse.modules.investments.service import views as inv_views
    from finanse.modules.investments.store import alerts as alert_store
    from finanse.modules.investments.store import convert, journal

    service, validation, views = _research()
    s, pid = ctx.session, ctx.profile_id
    owned = owner_named_ids(ctx)
    positions = inv_views.positions(s, ctx.profile)["positions"]
    summary = views.summary(s, ctx.profile, positions=positions)
    by_id = {i["instrument_id"]: i for i in summary["instruments"]}
    theses: dict[int, Any] = {}
    for t in journal.theses(s, pid):
        theses.setdefault(t.instrument_id, t)
    held_rows = []
    for p in positions:
        inst = p.get("instrument") or {}
        iid = inst.get("id")
        if not isinstance(iid, int) or iid not in by_id or iid in owned:
            continue  # owner-named / cash: never researched
        held_rows.append(
            _instrument(inst, owned, ctx)
            | {
                "bucket": L.category(p.get("bucket")),
                "weight": L.pct(p.get("weight")),
                "watched": L.flag(by_id[iid]["watched"]),
                "entry_type": L.category(getattr(theses.get(iid), "entry_type", None)),
                "thesis": _thesis(theses.get(iid)),
                "research": _research_fields(by_id[iid]),
            }
        )
    watch_rows = []
    held_ids = {
        p["instrument"]["id"] for p in positions if isinstance(p["instrument"].get("id"), int)
    }
    for item in alert_store.watchlist(s, pid):
        iid = item.instrument_id
        if iid in held_ids or iid not in by_id or iid in owned:
            continue
        watch_rows.append(
            _instrument(by_id[iid]["instrument"], owned, ctx)
            | {
                "item_id": L.ref(item.id),
                "source": L.category(item.source),
                "added_at": L.date(item.added_at),
                "note": L.text(item.note),
                "entry_type": L.category(getattr(theses.get(iid), "entry_type", None)),
                "thesis": _thesis(theses.get(iid)),
                "research": _research_fields(by_id[iid]),
            }
        )
    st = strategy_files.load(s, ctx.profile)
    criteria = st.config.watchlist.values if st.config is not None else {}
    now = convert.aware(dt.datetime.now(dt.UTC))
    candidate_rows = s.exec(
        select(InvResearchNote).where(
            InvResearchNote.profile_id == pid, InvResearchNote.kind == "candidate"
        )
    ).all()
    open_candidates, cooldown = [], []
    for r in candidate_rows:
        details = r.details or {}
        cand = details.get("candidate") or {}
        if r.cooldown_until is not None and convert.aware(r.cooldown_until) > now:
            cooldown.append(
                {
                    "candidate": L.symbol(cand.get("symbol") or r.candidate_key),
                    "until": L.date(convert.aware(r.cooldown_until).date()),
                }
            )
        elif (
            r.dismissed_at is None
            and convert.aware(r.expires_at) > now
            and not details.get("accepted_at")
        ):
            open_candidates.append(
                {
                    "note_id": L.ref(r.id),
                    "candidate": L.symbol(cand.get("symbol") or r.candidate_key),
                    "title": L.text(r.title),
                    "entry_type": L.category(details.get("entry_type")),
                    "observed_at": L.date(r.observed_at),
                }
            )
    events = []
    for r in service.notes(s, pid, now=now):
        details = r.details or {}
        when = details.get("event_date")
        if not when or when < ctx.today.isoformat() or (r.instrument_id in owned):
            continue
        events.append(
            {
                "event": L.text(details.get("event")),
                "event_date": L.date(when),
                "instrument_id": L.ref(r.instrument_id),
                "theme": L.text(r.theme),
                "note_id": L.ref(r.id),
            }
        )
    events.sort(key=lambda e: e["event_date"].value)
    running = service.running_run(s, pid, now)
    return {
        "as_of": L.date(ctx.today),
        "positions": held_rows,
        "watchlist": watch_rows,
        "themes": [
            {
                "theme": L.text(t["theme"]),
                "notes": L.count(t["notes"]),
                "direction": L.category(t["direction"]),
                "sentiment_8w": [L.pct(v) for v in t["sentiment_8w"]],
                "last_observed_at": L.date(t["last_observed_at"]),
            }
            for t in summary["themes"]
        ],
        "strategy": {
            "state": L.category(st.state),
            "version": L.count(st.version.version if st.version is not None else None),
            "entry_types": [L.category(e) for e in THESIS_ENTRY_TYPES],
            "entry_types_in_use": _entry_types_in_use(theses, set(by_id) - owned),
            "candidate_criteria": [
                {"criterion": L.category(str(k)), "threshold": L.level(v)}
                for k, v in sorted(criteria.items())
            ],
            "buckets": _buckets(st.config),
            "benchmark": None
            if st.config is None or st.config.benchmark is None
            else {
                "id": L.category(st.config.benchmark.id),
                "proxy": L.symbol(st.config.benchmark.proxy),
            },
            "sections": _sections(ctx, st),
        },
        "exposure": _exposure(positions, owned),
        "candidates": {"open": open_candidates, "dismissed_cooldown": cooldown},
        "upcoming_events": events[:30],
        "last_run": _run(summary.get("last_run")),
        "last_done_run": _run(views.run_dict(s, service.latest_run(s, pid, status="done"), now)),
        "running_run_id": L.ref(running.id if running is not None else None),
        "week_starts": [L.date(w) for w in summary["week_starts"]],
        "limits": {
            "title_max": L.count(120),
            "summary_max": L.count(1200),
            "sources_max": L.count(validation.SOURCES_MAX),
            "note_ttl_days": L.count(30),
            "notes_per_run": L.count(service.MAX_NOTES_PER_RUN),
            "candidate_cooldown_days": L.count(service.CANDIDATE_COOLDOWN.days),
        },
        "boundaries": [L.text(b) for b in BOUNDARIES],
        "note": L.text(
            "weights are fractions of the portfolio total (1 = 100%); sentiment_8w has one score "
            "per ISO week (week_starts, oldest first) in [-1, 1], null = no notes that week; "
            "health: invalidated, weakened, supported, current, no_research, no_thesis (30-day "
            "window, reset when the thesis changes)"
        ),
    }


def research_notes(
    ctx: ToolContext,
    since: str | None = None,
    kind: str | None = None,
    include_dismissed: bool = True,
    limit: int = 100,
) -> dict:
    service, validation, views = _research()
    moment = None
    if since:
        moment = validation.parse_moment(since)
        if moment is None:
            raise ToolError("since must be a date (YYYY-MM-DD) or an ISO timestamp")
    else:
        moment = dt.datetime.combine(ctx.today - dt.timedelta(days=30), dt.time(), tzinfo=dt.UTC)
    rows = service.notes(
        ctx.session,
        ctx.profile_id,
        kinds=[kind] if kind else None,
        since=moment,
        include_dismissed=include_dismissed,
        include_expired=True,
        limit=limit,
    )
    owned = owner_named_ids(ctx)
    return {
        "since": L.date(moment),
        "notes": [_note(r, owned, ctx) for r in views.notes_view(ctx.session, ctx.profile, rows)],
        "note": L.text(
            "newest observation first; dismissed notes were rejected by the owner: do not add them "
            "again; a dismissed candidate is in cooldown (see research_context)"
        ),
    }


# --------------------------------------------------------------------------- #
# Write tools
# --------------------------------------------------------------------------- #


def start_research_run(ctx: ToolContext, scope: dict | None = None) -> dict:
    service, validation, _views = _research()
    try:
        parsed = validation.validate_scope(scope)
        row = service.start_run(ctx.session, ctx.profile, parsed)
    except (validation.ResearchInputError, service.ResearchError, service.ResearchNotFound) as e:
        raise _errors(e) from None
    stored = row.scope or {}
    return {
        "run_id": L.ref(row.id),
        "status": L.category(row.status),
        "started_at": L.date(row.started_at),
        "scope": {
            "held": L.flag(stored.get("held")),
            "watchlist": L.flag(stored.get("watchlist")),
            "candidates": L.flag(stored.get("candidates")),
            "scheduled": L.flag(stored.get("scheduled")),
            "themes": [L.text(t) for t in stored.get("themes") or []],
            "covered_instruments": L.count(len(stored.get("covered_instrument_ids") or [])),
        },
        "note": L.text(
            "add notes with add_research_note (run_id optional while this run is running), then "
            "finish_research_run; research_context lists the instruments, theses and criteria"
        ),
    }


def add_research_note(ctx: ToolContext, **arguments: Any) -> dict:
    service, validation, _views = _research()
    instrument = arguments.pop("instrument", None)
    run_id = arguments.pop("run_id", None)
    try:
        data = validation.validate_note(arguments, now=dt.datetime.now(dt.UTC))
        instrument_id = (
            service.resolve_reference(ctx.session, ctx.profile_id, str(instrument))
            if instrument is not None
            else None
        )
        added = service.add_note(
            ctx.session, ctx.profile, data, instrument_id=instrument_id, run_id=run_id
        )
    except (validation.ResearchInputError, service.ResearchError, service.ResearchNotFound) as e:
        raise _errors(e) from None
    row = added.note
    signal = added.signal
    return {
        "note_id": L.ref(row.id),
        "run_id": L.ref(row.run_id),
        "kind": L.category(row.kind),
        "instrument_id": L.ref(row.instrument_id),
        "theme": L.text(row.theme),
        "expires_at": L.date(row.expires_at),
        "signal": None
        if signal is None or signal.signal_id is None
        else {
            "signal_id": L.ref(signal.signal_id),
            "created": L.flag(signal.created),
            "escalated": L.flag(signal.escalated),
        },
        "warnings": [L.text(w) for w in added.warnings],
    }


def finish_research_run(
    ctx: ToolContext,
    run_id: int,
    status: str = "done",
    counts: dict | None = None,
    reason: str | None = None,
) -> dict:
    service, validation, _views = _research()
    try:
        row = service.finish_run(
            ctx.session, ctx.profile, run_id, status=status, counts=counts, reason=reason
        )
    except (validation.ResearchInputError, service.ResearchError, service.ResearchNotFound) as e:
        raise _errors(e) from None
    counts_out = row.counts or {}
    return {
        "run_id": L.ref(row.id),
        "status": L.category(row.status),
        "finished_at": L.date(row.finished_at),
        "counts": {
            "notes": L.count(counts_out.get("notes")),
            "signals": L.count(counts_out.get("signals")),
            "candidates": L.count(counts_out.get("candidates")),
            "by_kind": {k: L.count(counts_out.get("by_kind", {}).get(k)) for k in _KINDS},
            **{k: L.count(counts_out.get(k)) for k in validation.RUN_COUNT_KEYS if k in counts_out},
        },
        "reason": L.text(counts_out.get("reason")),
    }


_SOURCE_SCHEMA = {
    "type": "array",
    "description": "1-10 sources: {url (http(s), original publisher), publisher, published_at "
    "(YYYY-MM-DD), title?}",
}

TOOLS = (
    ToolSpec(
        "research_context",
        "investments",
        "Context for a research run: held instruments (weights as fractions) and watched ones, each "
        "with its thesis (entry type, thesis, invalidation, exit plan) and research state (thesis "
        "health, relation counts, 8-week sentiment, last researched), themes, the strategy's entry "
        "types and candidate criteria, open and dismissed (cooldown) candidates, known upcoming "
        "events, the last run, limits and boundaries.",
        research_context,
    ),
    ToolSpec(
        "research_notes",
        "investments",
        "Research notes stored since a date (default the last 30 days; by storing time), newest "
        "observation first, incl. dismissed ones (rejected by the owner: never add them again).",
        research_notes,
        properties={
            "since": {"type": "string", "maxLength": 40},
            "kind": {"type": "string", "enum": _KINDS},
            "include_dismissed": {"type": "boolean", "default": True},
            "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100},
        },
    ),
    ToolSpec(
        "start_research_run",
        "investments",
        "Open a research run. scope: {held: true, watchlist: true, candidates: true, themes: "
        "[topics], instruments: [ids or symbols], scheduled: false (true for the scheduled "
        "routine)}. Another run still running is a conflict: finish it first.",
        start_research_run,
        properties={"scope": {"type": "object"}},
        write=True,
    ),
    ToolSpec(
        "add_research_note",
        "investments",
        "Store one sourced research note (facts and sentiment only: no recommendation, price "
        "prediction, target, amounts or sizes). About a held / watched instrument (instrument: id "
        "or symbol from research_context), a theme (sector / macro topic), or, for kind candidate, a "
        "new instrument (candidate {symbol_or_isin, name, exchange?, currency?} + details "
        "{entry_type, criteria [{text, met, threshold?}], context?, bucket?}). thesis_relation "
        "(supports | weakens | invalidates | neutral) needs an instrument with a thesis, else none; "
        "thesis_field names the thesis field it bears on. details.event + event_date record a known "
        "upcoming event; details.scale (small | medium | large) the size of a community discussion. "
        "Title <= 120, summary <= 1200 characters (Polish). invalidates -> action signal, strength "
        "3 -> info signal.",
        add_research_note,
        properties={
            "kind": {"type": "string", "enum": _KINDS},
            "polarity": {"type": "string", "enum": ["positive", "negative", "neutral"]},
            "strength": {"type": "integer", "minimum": 1, "maximum": 3},
            "title": {"type": "string", "maxLength": 120},
            "summary": {"type": "string", "maxLength": 1200},
            "sources": _SOURCE_SCHEMA,
            "instrument": {"type": "string", "maxLength": 40},
            "theme": {"type": "string", "maxLength": 60},
            "thesis_relation": {"type": "string", "enum": _RELATIONS, "default": "none"},
            "thesis_field": {"type": "string", "enum": _FIELDS},
            "candidate": {"type": "object"},
            "details": {"type": "object"},
            "observed_at": {"type": "string", "maxLength": 40},
            "expires_in_days": {"type": "integer", "minimum": 1, "maximum": 90},
            "run_id": {"type": "integer", "minimum": 1},
        },
        required=("kind", "polarity", "strength", "title", "summary", "sources"),
        write=True,
    ),
    ToolSpec(
        "finish_research_run",
        "investments",
        "Close a running research run: status done (default) or failed (with a short reason); "
        "counts: optional {sources_checked, instruments_covered, themes_covered, "
        "candidates_screened, skipped}. The server adds notes, signals and candidates.",
        finish_research_run,
        properties={
            "run_id": {"type": "integer", "minimum": 1},
            "status": {"type": "string", "enum": ["done", "failed"], "default": "done"},
            "counts": {"type": "object"},
            "reason": {"type": "string", "maxLength": 200},
        },
        required=("run_id",),
        write=True,
    ),
)
