"""Research MCP tools (investments module): the weekly research routine (``market-research`` skill)
reads its context and writes runs and notes through these thin adapters over
``modules.investments.research``.

Read: ``research_context`` (held and watched instruments with weights and market segments, theses
(entry type, invalidation, exit plan), thesis health and sentiment, the market segments with the
week's / 4 weeks' move attribution, the macro regime cards (P6, public data: identical in both
privacy modes) and their note keys, the strategy's candidate criteria, dismissed candidates in
cooldown, known upcoming events, the last run, limits), ``research_notes(since?, segment?)``.
Write: ``start_research_run(scope)``, ``add_research_note(...)`` (schema-validated: sources with URL,
publisher and date required, bounded lengths, no amounts / targets / sizes, no recommendation or price
prediction, no paywall-bypass links; segment notes (market segments and ``macro_*`` regimes) short,
one per key and week; ``details.brief`` (P9) on segment / macro notes; near duplicates of the last 60
days refused; the weekly run's novelty limits, lifted for a ``full_refresh`` run),
``set_topic_market_view(segment, assessment, outlook, sources)`` (P11: the topic's one current market
view directly under its thesis, separate from notes; the outlook cites a quantitative industry
estimate of market / demand growth, 1-6 sources required; no buy / sell call, no security price call),
``upsert_topic_thesis(segment, thesis, invalidation?)`` (a draft only, never over the owner's thesis),
``finish_research_run(run_id, ...)``, ``set_instrument_segment(instrument, segment)``
(a direct classification write, like ``set_merchant_category``; macro keys are refused: they are note
targets, never instrument segments).

Privacy: owner-named instruments (claims, private loans) and cash are never researched (not listed,
refused as a note's instrument or segment target). Free text (titles, summaries, theses, source fields)
is a ``text`` label: identifiers are always scrubbed and money amounts in strict mode, like every text
field. Weights, contributions, returns and sentiment scores are fractions (``percent``; the segment
attribution carries no amounts, so strict and full output are the same); candidate-criteria thresholds
are screening parameters about public companies (``level``), never personal amounts; from 1 million
they are compact Polish text (``1 mld``, ``market`` label) so they never form the long digit run the
leak check refuses.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec
from .investments import owner_named_ids, public_label

_log = logging.getLogger(__name__)

_KINDS = ["news", "earnings", "community", "trend", "macro", "candidate"]
_RELATIONS = ["supports", "weakens", "invalidates", "fulfills", "neutral", "none"]
_FIELDS = ["entry_type", "thesis", "invalidation", "exit_plan", "size_plan"]
BOUNDARIES = (
    (
        "research notes contain sourced facts; each topic's thesis may carry one separate current "
        "market assessment and forward market / adoption outlook; no buy / sell recommendation, "
        "security price prediction, price target or analyst rating"
    ),
    "never bypass paywalls or bot protection; cite the original publisher's URL",
    "community sentiment (Reddit, X, forums) is noisy: kind community, strength counts as 1",
    (
        "a note invalidating a thesis becomes an action signal, strength 3 an info signal (one per "
        "instrument or segment and week); candidates never become signals"
    ),
    "summaries in Polish, numbers as facts with their source; no personal amounts or sizes",
    (
        "company facts go on the instrument; a segment note is about the market segment only (at "
        "most one per segment and week, only when something changed)"
    ),
)


def _segment_keys() -> list[str]:
    from cashu.modules.investments.research.segments import SEGMENT_KEYS

    return list(SEGMENT_KEYS)


def _note_segment_keys() -> list[str]:
    """Keys a segment note may name: the market segments and the macro regimes (P6)."""
    from cashu.modules.investments.research.segments import NOTE_SEGMENT_KEYS

    return list(NOTE_SEGMENT_KEYS)


def _segment_catalog_text() -> str:
    from cashu.modules.investments.research.segments import SEGMENTS

    return ", ".join(f"{s.key} ({s.label})" for s in SEGMENTS)


def _macro_catalog_text() -> str:
    from cashu.modules.investments.research.segments import MACRO_SEGMENTS

    return ", ".join(f"{s.key} ({s.label})" for s in MACRO_SEGMENTS)


def _macro_refusals() -> dict[str, str]:
    from cashu.modules.investments.research.segments import MACRO_KEYS, NOT_INSTRUMENT_SEGMENT

    return dict.fromkeys(MACRO_KEYS, NOT_INSTRUMENT_SEGMENT)


def _topic_cooldowns(ctx: ToolContext) -> dict:
    from cashu.modules.investments.research import topic_theses

    return topic_theses.cooldowns(ctx.session, ctx.profile_id)


def _similarity():
    from cashu.modules.investments.research import similarity

    return similarity


def _topic_limits() -> tuple[int, int]:
    from cashu.modules.investments.models import TOPIC_INVALIDATION_MAX, TOPIC_THESIS_MAX

    return TOPIC_THESIS_MAX, TOPIC_INVALIDATION_MAX


def _research():
    from cashu.modules.investments.research import service, validation, views

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


def _recommendation(inst: Any) -> dict:
    def value(key: str):
        return inst.get(key) if isinstance(inst, dict) else getattr(inst, key, None)

    return {
        "recommendation": L.category(value("plan")),
        "recommendation_at": L.date(value("plan_at")),
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
        "core_changed_at": L.date(row.core_changed_at or row.updated_at),
    }


def _research_fields(item: dict | None) -> dict:
    item = item or {}
    counts = item.get("counts") or {}
    return {
        "health": L.category(item.get("health")),
        "health_predates_thesis": L.flag(bool(item.get("health_predates_thesis"))),
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
        # stored before the thesis' last core change: may judge an older thesis (P2)
        "predates_thesis": L.flag(bool(row.get("predates_thesis"))),
        "title": L.text(row["title"]),
        "summary": L.text(row["summary"]),
        "instrument": _instrument(inst, owned, ctx) if inst else None,
        "theme": L.text(row.get("theme")),
        "segment": L.category(row.get("segment")),
        "segment_label": L.category(row.get("segment_label")),
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
            "brief": _brief_out(details.get("brief")),
        },
        "sources": _sources_out(row.get("sources")),
        "signal_id": L.ref(row.get("signal_id")),
        "observed_at": L.date(row.get("observed_at")),
        "expires_at": L.date(row.get("expires_at")),
        "expired": L.flag(bool(row.get("expired"))),
        "dismissed": L.flag(bool(row.get("dismissed"))),
        "dismissed_at": L.date(row.get("dismissed_at")),
        "created_at": L.date(row.get("created_at")),
    }


def _brief_out(brief: dict | None, extra: dict | None = None) -> dict | None:
    """A note's ``details.brief`` (P9) as the owner sees it: plain Polish text (``text`` labels)."""
    if not isinstance(brief, dict):
        return None
    return {
        "headline": L.text(brief.get("headline")),
        "why": L.text(brief.get("why")),
        "supports": [L.text(x) for x in brief.get("supports") or []],
        "risks": [L.text(x) for x in brief.get("risks") or []],
    } | (extra or {})


def _sources_out(sources: list | None) -> list[dict]:
    """Note or topic-view sources as the agent reads them."""
    return [
        {
            "publisher": L.text(s.get("publisher")),
            "title": L.text(s.get("title")),
            "url": L.text(s.get("url")),
            "published_at": L.date(s.get("published_at")),
        }
        for s in sources or []
        if isinstance(s, dict)
    ]


def _topic_thesis(row: dict | None) -> dict | None:
    """``research_context.segments[].thesis`` (P9)."""
    if not row:
        return None
    return {
        "text": L.text(row["thesis"]),
        "invalidation": L.text(row.get("invalidation")),
        "assessment": L.text(row.get("assessment")),
        "outlook": L.text(row.get("outlook")),
        "view_updated_at": L.date(row.get("view_updated_at")),
        "view_sources": _sources_out(row.get("view_sources")),
        "draft": L.flag(row["draft"]),
        "created_by": L.category(row["created_by"]),
        "updated_at": L.date(row["updated_at"]),
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
        "full_refresh": L.flag(bool(run.get("full_refresh"))),
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
    from cashu.modules.investments.research.strategy_text import strategy_sections
    from cashu.modules.investments.service import strategy as strategy_files

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


def _threshold(value: float | None) -> L.Labelled:
    """A candidate-criteria threshold: a number below :data:`labels.COMPACT_FROM`, else compact
    Polish text (``min_market_cap_pln: 1000000000`` -> ``1 mld``)."""
    if value is None or abs(float(value)) < L.COMPACT_FROM:
        return L.level(value)
    return L.market(L.compact_number(value))


def _segment_fields(inst: dict | None) -> dict:
    inst = inst or {}
    return {
        "segment": L.category(inst.get("segment")),
        "segment_source": L.category(inst.get("segment_source")),
    }


def _symbols(ctx: ToolContext, items: list[dict], owned: set[int]) -> list[L.Labelled]:
    """Labels of the attributed instruments (owner-named ones are never named here)."""
    return [
        L.text(public_label(ctx, i.get("label")))
        for i in items
        if i.get("instrument_id") not in owned and i.get("label")
    ]


def _moves(ctx: ToolContext, items: list[dict], owned: set[int]) -> list[dict]:
    """The attributed instruments of a segment row with their 1w return and contribution
    (owner-named ones are never named here)."""
    return [
        {
            "symbol": L.text(public_label(ctx, i.get("label"))),
            "return_1w": L.pct(i.get("return")),
            "contribution_1w": L.pct(i.get("contribution")),
        }
        for i in items
        if i.get("instrument_id") not in owned and i.get("label")
    ]


def _segments(ctx: ToolContext, owned: set[int]) -> tuple[list[dict], dict | None, dict | None]:
    """``research_context.segments`` (1w and 4w rows: 1w fields + the 4w contribution + the topic trend
    ``trend_1w`` / ``trend_4w`` / ``members``, P7), ``currency`` and ``unassigned``; empty when the
    attribution cannot be computed (the context still answers)."""
    from cashu.modules.investments.research import segment_service

    try:
        week = segment_service.segments_view(ctx.session, ctx.profile, window="1w")
        month = segment_service.segments_view(ctx.session, ctx.profile, window="4w")
    except Exception:  # noqa: BLE001 - research keeps working without the attribution
        _log.exception("research_context: segment attribution failed")
        return [], None, None
    month_rows = {r["segment"]: r for r in month["segments"]}
    week_keys = {r["segment"] for r in week["segments"]}
    # the union of both windows: a segment that moved over 4 weeks but has no 1w row (sold since)
    # still shows, with no 1w exposure
    month_only = sorted(
        (r for r in month["segments"] if r["segment"] not in week_keys),
        key=lambda r: -abs(r["contribution"] or 0.0),
    )
    rows = []
    for r in [*week["segments"], *month_only]:
        in_week = r["segment"] in week_keys
        other = month_rows.get(r["segment"])
        rows.append(
            {
                "segment": L.category(r["segment"]),
                "label": L.category(r["label"]),
                "weight": L.pct(r["weight"] if in_week else 0.0),
                "contribution_1w": L.pct(r["contribution"] if in_week else 0.0),
                "return_1w": L.pct(r["return"] if in_week else None),
                "contribution_4w": L.pct(other["contribution"] if other else None),
                "trend_1w": L.pct(r["trend_1w"]),
                "trend_4w": L.pct(r["trend_4w"]),
                "members": L.count(r["members"]),
                "instruments": _moves(ctx, r["instruments"] if in_week else [], owned),
                "last_note_at": L.date(r["last_note_at"]),
                "note_this_week": L.flag(r["note_this_week"]),
                "briefs": [
                    {
                        "note_id": L.ref(b["note_id"]),
                        "headline": L.text(b["headline"]),
                        "why": L.text(b["why"]),
                        "observed_at": L.date(b["observed_at"]),
                        "kind": L.category(b["kind"]),
                        "polarity": L.category(b["polarity"]),
                    }
                    for b in r.get("briefs") or []
                ],
                "thesis": _topic_thesis(r.get("thesis")),
            }
        )
    currency = {
        "contribution_1w": L.pct(week["currency"]["contribution"]),
        "contribution_4w": L.pct(month["currency"]["contribution"]),
    }
    unassigned = week["unassigned"]
    return (
        rows,
        currency,
        None
        if unassigned is None
        else {
            "weight": L.pct(unassigned["weight"]),
            "symbols": _symbols(ctx, unassigned["instruments"], owned),
        },
    )


def _macro(ctx: ToolContext) -> list[dict]:
    """``research_context.macro``: the five macro regime cards (public market data, identical in
    strict and full mode; metric values are the server's Polish text); empty when they cannot be
    computed (the context still answers)."""
    from cashu.modules.investments.macro import service as macro_service

    try:
        cards = macro_service.macro_view(ctx.session, ctx.profile, as_of=ctx.today)["regimes"]
    except Exception:  # noqa: BLE001 - research keeps working without the macro cards
        _log.exception("research_context: macro regimes failed")
        return []
    return [
        {
            "key": L.category(c["key"]),
            "note_key": L.category(f"macro_{c['key']}"),
            "label": L.category(c["label"]),
            "state": L.category(c["state"]),
            "state_label": L.category(c["state_label"]),
            "summary": L.market(c["summary"] if L.market_ok(c["summary"]) else None),
            "plain": L.text(c["plain"]),
            "brief": None
            if c["brief"] is None
            else _brief_out(
                c["brief"],
                {
                    "note_id": L.ref(c["brief"]["note_id"]),
                    "observed_at": L.date(c["brief"]["observed_at"]),
                },
            ),
            "since": L.date(c["since"]),
            "since_open": L.flag(c["since_open"]),
            "since_min": L.date(c["since_min"]),
            "as_of": L.date(c["as_of"]),
            "metrics": [
                {"label": L.market(m["label"]), "text": L.market(m["text"])} for m in c["metrics"]
            ],
            "stale": L.flag(c["stale"]),
            "missing": L.flag(c["missing"]),
            "last_note_at": L.date(c["last_note_at"]),
            "note_this_week": L.flag(c["note_this_week"]),
        }
        for c in cards
    ]


# --------------------------------------------------------------------------- #
# Read tools
# --------------------------------------------------------------------------- #


def research_context(ctx: ToolContext) -> dict:
    from sqlmodel import select

    from cashu.modules.investments.models import THESIS_ENTRY_TYPES, InvResearchNote
    from cashu.modules.investments.service import strategy as strategy_files
    from cashu.modules.investments.service import views as inv_views
    from cashu.modules.investments.store import alerts as alert_store
    from cashu.modules.investments.store import convert, journal
    from cashu.modules.investments.store import instruments as instrument_store

    service, validation, views = _research()
    s, pid = ctx.session, ctx.profile_id
    owned = owner_named_ids(ctx)
    positions = inv_views.positions(s, ctx.profile)["positions"]
    summary = views.summary(s, ctx.profile, positions=positions)
    by_id = {i["instrument_id"]: i for i in summary["instruments"]}
    profile_instruments = instrument_store.load(s, by_id, profile_id=pid)
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
                **_recommendation(inst),
                "bucket": L.category(p.get("bucket")),
                "weight": L.pct(p.get("weight")),
                **_segment_fields(inst),
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
                **_recommendation(profile_instruments.get(iid)),
                "item_id": L.ref(item.id),
                **_segment_fields(by_id[iid]["instrument"]),
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
                "segment": L.category(r.segment),
                "theme": L.text(r.theme),
                "note_id": L.ref(r.id),
            }
        )
    events.sort(key=lambda e: e["event_date"].value)
    running = service.running_run(s, pid, now)
    segment_rows, currency, unassigned = _segments(ctx, owned)
    from cashu.modules.investments.research.segments import MACRO_SEGMENTS, SEGMENTS

    return {
        "as_of": L.date(ctx.today),
        "positions": held_rows,
        "watchlist": watch_rows,
        "segments": segment_rows,
        "currency": currency,
        "unassigned": unassigned,
        "segment_catalog": [
            {
                "segment": L.category(x.key),
                "label": L.category(x.label),
                "group": L.category(x.group),
            }
            for x in SEGMENTS
        ],
        "macro": _macro(ctx),
        "macro_catalog": [
            {"segment": L.category(x.key), "label": L.category(x.label)} for x in MACRO_SEGMENTS
        ],
        "strategy": {
            "state": L.category(st.state),
            "version": L.count(st.version.version if st.version is not None else None),
            "entry_types": [L.category(e) for e in THESIS_ENTRY_TYPES],
            "entry_types_in_use": _entry_types_in_use(theses, set(by_id) - owned),
            "candidate_criteria": [
                {"criterion": L.category(str(k)), "threshold": _threshold(v)}
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
        "topic_thesis_cooldown": [
            {"segment": L.category(key), "until": L.date(until.date())}
            for key, until in sorted(_topic_cooldowns(ctx).items())
        ],
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
            "weekly_instruments_max": L.count(service.WEEKLY_INSTRUMENTS_MAX),
            "weekly_notes_per_instrument": L.count(service.WEEKLY_NOTES_PER_INSTRUMENT),
            "segment_notes_per_week": L.count(service.SEGMENT_NOTES_PER_WEEK),
            "weekly_segment_notes_max": L.count(service.WEEKLY_SEGMENT_NOTES_MAX),
            "segment_summary_max": L.count(validation.SEGMENT_SUMMARY_MAX),
            "brief_headline_max": L.count(validation.BRIEF_HEADLINE_MAX),
            "brief_why_max": L.count(validation.BRIEF_WHY_MAX),
            "brief_items_max": L.count(validation.BRIEF_ITEMS_MAX),
            "brief_item_max": L.count(validation.BRIEF_ITEM_MAX),
            "near_duplicate_days": L.count(_similarity().WINDOW_DAYS),
            "topic_thesis_max": L.count(_topic_limits()[0]),
            "topic_invalidation_max": L.count(_topic_limits()[1]),
        },
        "boundaries": [L.text(b) for b in BOUNDARIES],
        "note": L.text(
            "weights are fractions of the portfolio total (1 = 100%); sentiment_8w has one score "
            "per ISO week (week_starts, oldest first) in [-1, 1], null = no notes that week; "
            "health: invalidated, weakened, fulfilled, supported, current, no_research, no_thesis "
            "(30-day window; a thesis edit never drops notes: health_predates_thesis / "
            "predates_thesis tag notes stored before the thesis' last core change; fulfilled = a "
            "fulfills note: the outcome the thesis expected has happened); segments: what moved "
            "the portfolio by market segment (contribution = share of the portfolio value at the "
            "window start, e.g. -0.008 = -0.8 pp; return = the segment's own local price return; "
            "currency = the FX part), segments with an active note, a cost-valued holding or only a "
            "4-week move show with contribution 0 / weight 0; per ISO week the weekly runs (scope "
            "held: true) and notes written without a run cover at most weekly_instruments_max "
            "instruments, weekly_notes_per_instrument each, weekly_segment_notes_max segment notes "
            "(strength 3, invalidates and fulfills always pass; on-demand runs are exempt)"
        ),
    }


def research_notes(
    ctx: ToolContext,
    since: str | None = None,
    kind: str | None = None,
    include_dismissed: bool = True,
    limit: int = 100,
    segment: str | None = None,
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
        segment=segment,
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
    if isinstance(scope, dict) and "themes" in scope:
        raise ToolError(
            "scope.themes is gone: use segments: [catalog keys] (research_context.segment_catalog)",
            "invalid_arguments",
        )
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
            "full_refresh": L.flag(bool(stored.get("full_refresh"))),
            "segments": [L.category(k) for k in stored.get("segments") or []],
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
    from cashu.modules.investments.service import plans

    plans.sync_after_note(ctx.session, ctx.profile, row)  # the plan checks follow the health
    signal = added.signal
    return {
        "note_id": L.ref(row.id),
        "run_id": L.ref(row.run_id),
        "kind": L.category(row.kind),
        "instrument_id": L.ref(row.instrument_id),
        "segment": L.category(row.segment),
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


def set_topic_market_view(
    ctx: ToolContext, segment: str, assessment: str, outlook: str, sources: list | None = None
) -> dict:
    """Set the topic's current market view (``Ocena teraz`` / ``Perspektywa``) under its thesis,
    with the sources of the industry estimates its outlook cites."""
    from cashu.modules.investments.research import topic_theses

    try:
        row = topic_theses.set_market_view(
            ctx.session,
            ctx.profile_id,
            segment,
            assessment,
            outlook,
            sources=sources,
            by=topic_theses.AGENT,
        )
    except topic_theses.TopicThesisError as e:
        raise ToolError(str(e)) from None
    return {
        "segment": L.category(row.segment),
        "thesis_draft": L.flag(row.draft),
        "assessment": L.text(row.assessment),
        "outlook": L.text(row.outlook),
        "view_updated_at": L.date(row.view_updated_at),
        "view_sources": _sources_out(row.view_sources),
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


def set_instrument_segment(ctx: ToolContext, instrument: str, segment: str | None) -> dict:
    """The market segment of a held or watched instrument (a direct classification write, like
    ``set_merchant_category``; stored as set by the agent); an explicit null clears it (the
    automatic guess applies). A segment the owner set is never changed or cleared (conflict)."""
    from cashu.modules.investments.research.segments import segment_of
    from cashu.modules.investments.store import instruments as instrument_store

    service, _validation, _views = _research()
    try:
        iid = service.resolve_reference(ctx.session, ctx.profile_id, str(instrument))
    except (service.ResearchError, service.ResearchNotFound) as e:
        raise _errors(e) from None
    if iid not in service.held_instrument_ids(
        ctx.session, ctx.profile_id
    ) | service.watched_instrument_ids(ctx.session, ctx.profile_id):
        raise ToolError("only a held or watched instrument gets a segment", "conflict")
    try:
        instrument_store.set_segment(
            ctx.session, iid, segment, profile_id=ctx.profile_id, by="agent"
        )
    except instrument_store.OwnerSegment as e:
        raise ToolError(str(e), "conflict") from None
    except instrument_store.ClassificationError as e:
        raise ToolError(str(e)) from None
    inst = instrument_store.load_one(ctx.session, iid, profile_id=ctx.profile_id)
    assert inst is not None
    key, source = segment_of(inst, inst.segment, inst.segment_by)
    return {
        "instrument_id": L.ref(iid),
        "segment": L.category(key),
        "segment_source": L.category(source),
    }


def upsert_topic_thesis(
    ctx: ToolContext, segment: str, thesis: str, invalidation: str | None = None
) -> dict:
    """A DRAFT thesis on a topic (P9): created, or the agent's own draft updated (``invalidation``
    omitted keeps the stored one). The owner's thesis (or a draft the owner confirmed) is never
    overwritten (conflict). The owner confirms or edits the draft in the app."""
    from cashu.modules.investments.research import topic_theses

    try:
        row, created = topic_theses.upsert_draft(
            ctx.session, ctx.profile_id, segment, thesis, invalidation
        )
    except topic_theses.OwnerThesis as e:
        raise ToolError(str(e), "conflict") from None
    except topic_theses.TopicThesisError as e:
        raise ToolError(str(e)) from None
    return {
        "segment": L.category(row.segment),
        "created": L.flag(created),
        "draft": L.flag(row.draft),
        "note": L.text(
            "saved as a draft the owner confirms or edits in the app (shown as [do potwierdzenia])"
        ),
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
        "with its current model recommendation and recommendation date (null means the final "
        "set_recommendations gate must receive it), "
        "with its market segment (segment, segment_source owner | agent | auto | null), thesis (entry type, "
        "thesis, invalidation, exit plan) and research state (thesis health, relation counts, "
        "8-week sentiment, last researched); segments: what moved the portfolio this week and over 4 "
        "weeks by market segment (weight, contribution, return, instruments, trend_1w / trend_4w = "
        "the equal-weighted price move of its held and watched instruments, members, last_note_at, "
        "note_this_week; briefs = up to 3 active brief notes (headline, why) the owner reads under the "
        "topic, newest first; thesis = the topic thesis {text, invalidation, draft, created_by, "
        "updated_at} or null; watched-only topics with weight 0), currency and unassigned; "
        "topic_thesis_cooldown: topics whose thesis the owner deleted (no new draft before "
        "until); "
        "segment_catalog; macro: the five macro regime cards (state_label, summary, plain = the "
        "beginner sentence the owner sees until a brief exists, brief = the active macro brief "
        "{headline, why, supports, risks} or null, since (null + "
        "since_open + since_min when the state began before the data), metrics as text, stale, missing, last_note_at, note_this_week; "
        "public data) and macro_catalog (their note keys); the strategy's entry types and "
        "candidate criteria, open and dismissed (cooldown) candidates, known upcoming events, the "
        "last run, limits (incl. the weekly novelty limits) and boundaries.",
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
            "segment": {
                "type": "string",
                "enum": _note_segment_keys(),
                "description": "only this market segment's or macro regime's notes",
            },
        },
    ),
    ToolSpec(
        "start_research_run",
        "investments",
        "Open a research run. scope: {held: true, watchlist: true, candidates: true, segments: "
        "[segment or macro keys], instruments: [ids or symbols], scheduled: false (true for the scheduled "
        "routine)}. A run covering the held positions is weekly: per ISO week, weekly runs and notes "
        "written without a run cover at most 6 instruments, 2 notes each, and 6 segment notes "
        "(strength 3, invalidates and fulfills always pass). A scope with only instruments or "
        "segments is on demand (the flags it leaves out default to false) and exempt. "
        "full_refresh: true ONLY when the owner explicitly asks for a full fresh research: the run "
        "is exempt from the weekly novelty limits and from one brief note per segment and week, never "
        "from the duplicate / near-duplicate checks or one non-brief note per segment and week; "
        "never together with scheduled. Another run still running is a conflict: finish it first.",
        start_research_run,
        properties={"scope": {"type": "object"}},
        write=True,
    ),
    ToolSpec(
        "add_research_note",
        "investments",
        "Store one sourced research note (facts and sentiment only; no analytical market view, "
        "recommendation, security price prediction, target, amounts or sizes). About a held / "
        "watched instrument (instrument: id "
        "or symbol from research_context), a market segment (segment: catalog key; no instrument, "
        "no candidate; kind macro | trend | news; thesis_relation none; summary <= 400 characters; "
        "at most one per segment and ISO week, only when something changed), a macro regime "
        "(segment: a macro_catalog key, same rules: only when its state changed since its last "
        "note or a dated decisive event happened this week), or, for kind "
        "candidate, a new instrument (candidate {symbol_or_isin, name, exchange?, currency?} + details "
        "{entry_type, criteria [{text, met, threshold?}], context?, bucket?}). thesis_relation "
        "(supports | weakens | invalidates | fulfills | neutral) needs an instrument with a thesis, "
        "else none; thesis_field names the thesis field it bears on (fulfills: thesis or exit_plan, "
        "a dated fact that the expected outcome happened or the exit target is met, never a sell "
        "call). details.event + event_date record a known "
        "upcoming event; details.scale (small | medium | large) the size of a community discussion. "
        "Title <= 120, summary <= 1200 characters (Polish). A topic's current assessment and outlook "
        "belong in set_topic_market_view, never in note details. invalidates -> action signal, strength "
        "3 -> info signal. A segment or macro note may carry details.brief {headline (8-80, a plain "
        "Polish sentence a beginner understands), why (<= 280, plain words), supports [<= 3 x 90] and "
        "risks [<= 3 x 90] (macro only: conditions that historically supported / weighed on such a "
        "market)}: the owner reads it on the home page; never wzrośnie / spadnie / będzie / prognoz* / "
        "kupuj / sprzedaj / cel cenowy, except in a sentence citing an institution's published "
        "forecast of a macro or market trend with who, how much and horizon (MFW prognozuje wzrost "
        "PKB USA o 2,1 % w 2027; projekcja Fed (dot plot); IEA szacuje popyt), the same in a note "
        "summary; never a price, valuation or index forecast, an analyst forecast or your own "
        "(prognozujemy); expires_in_days up to 90 (60 recommended). A topic note may "
        "carry thesis_relation supports | weakens | invalidates when the topic has a confirmed "
        "thesis (research_context segments[].thesis with draft false; thesis_field thesis); such an "
        "invalidates note passes the weekly segment cap. At most one brief note and one other note "
        "per segment and ISO week (a full_refresh run lifts it for brief notes). A note restating a "
        "fact already in a non-dismissed note of the same instrument / candidate / segment from the "
        "last 60 days (similar title, brief headline or headline + summary, same polarity, relation "
        "and direction) is refused as a near duplicate (count it skipped); a brief whose why "
        "changed passes the headline check.",
        add_research_note,
        properties={
            "kind": {"type": "string", "enum": _KINDS},
            "polarity": {"type": "string", "enum": ["positive", "negative", "neutral"]},
            "strength": {"type": "integer", "minimum": 1, "maximum": 3},
            "title": {"type": "string", "maxLength": 120},
            "summary": {"type": "string", "maxLength": 1200},
            "sources": _SOURCE_SCHEMA,
            "instrument": {"type": "string", "maxLength": 40},
            "segment": {
                "type": "string",
                "enum": _note_segment_keys(),
                "description": "market segment of a segment note: "
                + _segment_catalog_text()
                + "; or a macro regime (macro note): "
                + _macro_catalog_text(),
            },
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
        refused={
            "theme": "themes are gone: a market note takes segment (a catalog key from "
            "research_context.segment_catalog); company facts go on the instrument",
        },
    ),
    ToolSpec(
        "set_topic_market_view",
        "investments",
        "Write the topic's ONE current market view, shown to the owner directly under the topic "
        "thesis (Ocena teraz / Perspektywa), separate from notes; replaces the previous view "
        "(the owner's edit included), so keep it current after each topic research. The topic must "
        "have a thesis or your draft (upsert_topic_thesis first). assessment (20-400 Polish "
        "characters): the topic's market now (adoption, demand, investment, valuations of the topic "
        "as a whole). outlook (20-400): where the topic's market / adoption / demand is heading, "
        "resting on at least one quantitative industry estimate of market or demand growth cited "
        "as an estimate with who, how much and horizon (e.g. IFR szacuje 575 tys. instalacji "
        "robotów rocznie w 2028; IEA szacuje popyt centrów danych na ok. 945 TWh w 2030) plus the "
        "main risk; an outlook without a number other than a year / horizon is refused. sources "
        "(1-6, required): the reports behind those estimates, {url (http(s), original publisher), "
        "publisher, published_at (YYYY-MM-DD), title?}; they replace the stored ones. Refused: buy "
        "/ sell / hold wording, ratings, a price target, any price, valuation or index move of a "
        "security, of shares or of an index (kurs / akcje / notowania / wyceny / S&P 500 ... "
        "wzrosną), analyst forecasts.",
        set_topic_market_view,
        properties={
            "segment": {"type": "string", "enum": _segment_keys()},
            "assessment": {"type": "string", "minLength": 20, "maxLength": 400},
            "outlook": {"type": "string", "minLength": 20, "maxLength": 400},
            "sources": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "description": "1-6 sources of the cited estimates: {url (http(s), original "
                "publisher), publisher, published_at (YYYY-MM-DD), title?}",
            },
        },
        required=("segment", "assessment", "outlook", "sources"),
        write=True,
        refused_values={"segment": _macro_refusals()},
    ),
    ToolSpec(
        "upsert_topic_thesis",
        "investments",
        "Propose a DRAFT thesis on a market topic (segment: a segment_catalog key, never a macro key; "
        "thesis <= 600 characters, invalidation? <= 400, plain Polish, what has to stay true for the "
        "topic, never a price forecast or a call). Creates a draft or updates the agent's own draft "
        "(invalidation omitted keeps it). The owner's thesis (created_by owner, or a draft the owner "
        "confirmed: draft false) is never overwritten: conflict. Propose once for a held topic "
        "without a thesis (research_context segments[].thesis null); a topic whose thesis or draft "
        "the owner deleted is refused for 90 days (research_context topic_thesis_cooldown).",
        upsert_topic_thesis,
        properties={
            "segment": {"type": "string", "enum": _segment_keys()},
            "thesis": {"type": "string", "maxLength": 600},
            "invalidation": {"type": "string", "maxLength": 400},
        },
        required=("segment", "thesis"),
        write=True,
        refused_values={"segment": _macro_refusals()},
    ),
    ToolSpec(
        "finish_research_run",
        "investments",
        "Close a running research run: status done (default) or failed (with a short reason); "
        "counts: optional {sources_checked, instruments_covered, segments_covered, "
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
    ToolSpec(
        "set_instrument_segment",
        "investments",
        "Set the market segment of a held or watched instrument (instrument: id, symbol, ISIN or "
        "alias from research_context; segment: a catalog key, or an explicit null to clear it so "
        "the automatic guess applies). A segment the owner set (segment_source owner) is never "
        "changed or cleared (conflict); the agent may change its own (segment_source agent). "
        "Catalog: " + _segment_catalog_text() + ".",
        set_instrument_segment,
        properties={
            "instrument": {"type": "string", "maxLength": 40},
            "segment": {"type": "string", "enum": _segment_keys()},
        },
        required=("instrument",),
        nullable=("segment",),
        write=True,
        refused_values={"segment": _macro_refusals()},
    ),
)
