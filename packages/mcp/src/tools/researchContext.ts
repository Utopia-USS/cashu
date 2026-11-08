/** Research context assembled from real native portfolio/research/attribution/macro services. */
import { research } from "@cashu/domain/investments";
import { summaryOk } from "@cashu/domain/investments/macro";
import { investmentsResearch as R } from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import * as L from "../privacy/labels.js";
import { type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import * as F from "./researchLabels.js";

const BOUNDARIES = [
  "research notes contain sourced facts; each topic's thesis may carry one separate current market assessment and forward market / adoption outlook; a buy / sell view, price forecast or price target that follows from the owner's strategy belongs only in the model recommendation (set_recommendations), never in notes or views",
  "never bypass paywalls or bot protection; cite the original publisher's URL",
  "community sentiment (Reddit, X, forums) is noisy: kind community, strength counts as 1",
  "a note invalidating a thesis becomes an action signal, strength 3 an info signal (one per instrument or segment and week); candidates never become signals",
  "summaries in the app language (the server instructions name it), numbers as facts with their source; no personal amounts or sizes",
  "company facts go on the instrument; a segment note is about the market segment only (at most one per segment and week, only when something changed)",
];
const CONTEXT_NOTE =
  "weights are fractions of the portfolio total (1 = 100%); sentiment_8w has one score per ISO week (week_starts, oldest first) in [-1, 1], null = no notes that week; health: invalidated, weakened, fulfilled, supported, current, no_research, no_thesis (30-day window; a thesis edit never drops notes: health_predates_thesis / predates_thesis tag notes stored before the thesis' last core change; fulfilled = a fulfills note: the outcome the thesis expected has happened); segments: what moved the portfolio by market segment (weight and contribution = shares of the portfolio value at the window start, e.g. -0.008 = -0.8 pp; weight_now = the segment's share today, the positions source; return = the segment's own local price return; currency = the FX part; instruments: held false = sold within the window, its move still counts; new_in_window true = bought within the window, no share in the move yet), segments with an active note, a cost-valued holding or only a 4-week move show with contribution 0 / weight 0; per ISO week the weekly runs (scope held: true) and notes written without a run cover at most weekly_instruments_max instruments, weekly_notes_per_instrument each, weekly_segment_notes_max segment notes (strength 3, invalidates and fulfills always pass; on-demand runs are exempt)";
const METRIC =
  /(?:^|_)(?:pe|pb|ps|peg|ev|ebitda|eps|dividend|yield|payout|market_cap|cap|roe|roa|roic|margin|growth|beta|volatility|vol|debt|ratio|return|drawdown|rsi|ter|pct|percent|score|rating|age|years|months|days|volume|liquidity|free_float|float)(?:_|$)/;
function threshold(value: number, criterion: string, strict: boolean) {
  if (strict && !METRIC.test(criterion.toLowerCase())) return L.level(null);
  return Math.abs(value) < L.COMPACT_FROM ? L.level(value) : L.market(L.compactNumber(value));
}
/** A held position as the segment rows read it (the `positions` source: current holdings only). */
interface HeldRow {
  readonly id: string;
  readonly label: string | null;
  readonly segment: string | null;
  readonly weight: number | null;
}
function segments(
  ctx: ToolContext<NativeToolStore>,
  owned: ReadonlySet<string>,
  heldNow: readonly HeldRow[],
) {
  const services = ctx.store.research;
  if (services === undefined) return { segments: [], currency: null, unassigned: null };
  let week: ReturnType<typeof services.segments>, month: ReturnType<typeof services.segments>;
  try {
    week = services.segments("1w");
    month = services.segments("4w");
  } catch {
    return { segments: [], currency: null, unassigned: null };
  }
  const months = new Map(month.segments.map((row) => [row.segment, row])),
    keys = new Set(week.segments.map((row) => row.segment));
  const rows = [
    ...week.segments,
    ...month.segments
      .filter((row) => !keys.has(row.segment))
      .sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0)),
  ];
  const label = (text: string | null) => F.text(ctx.strict ? ctx.guard.publicName(text) : text);
  return {
    segments: rows.map((row) => {
      const inWeek = keys.has(row.segment),
        other = months.get(row.segment);
      const movers = inWeek ? row.instruments : [],
        moved = new Set(movers.map((item) => item.instrument_id)),
        current = heldNow.filter((h) => h.segment === row.segment && !owned.has(h.id));
      return {
        segment: F.category(row.segment),
        label: F.category(row.label),
        weight: F.percent(inWeek ? row.weight : 0),
        weight_now: F.percent(current.reduce((sum, h) => sum + (h.weight ?? 0), 0)),
        contribution_1w: F.percent(inWeek ? row.contribution : 0),
        return_1w: F.percent(inWeek ? row.return : null),
        contribution_4w: F.percent(other?.contribution),
        trend_1w: F.percent(row.trend_1w),
        trend_4w: F.percent(row.trend_4w),
        members: F.count(row.members),
        instruments: [
          ...movers
            .filter((item) => !owned.has(item.instrument_id) && item.label)
            .map((item) => ({
              symbol: label(item.label),
              held: F.flag(item.held),
              new_in_window: F.flag(false),
              return_1w: F.percent(item.return),
              contribution_1w: F.percent(item.contribution),
            })),
          // Bought within the window: held now, no start weight, so no share in the week's move.
          ...current
            .filter((h) => !moved.has(h.id) && h.label)
            .map((h) => ({
              symbol: label(h.label),
              held: F.flag(true),
              new_in_window: F.flag(true),
              return_1w: F.percent(null),
              contribution_1w: F.percent(null),
            })),
        ],
        last_note_at: F.date(row.last_note_at),
        note_this_week: F.flag(row.note_this_week),
        briefs: row.briefs.map((value) => {
          const b = F.object(value);
          return {
            note_id: F.ref("note", b.note_id),
            headline: F.text(b.headline),
            why: F.text(b.why),
            observed_at: F.date(b.observed_at),
            kind: F.category(b.kind),
            polarity: F.category(b.polarity),
          };
        }),
        thesis: F.topicThesis(row.thesis),
        valuation: F.valuation(row.valuation),
      };
    }),
    currency: {
      contribution_1w: F.percent(week.currency.contribution),
      contribution_4w: F.percent(month.currency.contribution),
    },
    unassigned:
      week.unassigned === null
        ? null
        : {
            weight: F.percent(week.unassigned.weight),
            symbols: week.unassigned.instruments
              .filter((item) => !owned.has(item.instrument_id) && item.label)
              .map((item) => F.text(ctx.strict ? ctx.guard.publicName(item.label) : item.label)),
          },
  };
}
function macro(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const service = ctx.store.research;
  let cards: ReturnType<NonNullable<typeof service>["macro"]>;
  try {
    cards = service?.macro() ?? [];
  } catch {
    return [];
  }
  return cards.map((card) => ({
    key: F.category(card.key),
    note_key: F.category(`macro_${card.key}`),
    label: F.category(card.label),
    state: F.category(card.state),
    state_label: F.category(card.state_label),
    summary: L.market(L.marketOk(card.summary, summaryOk) ? card.summary : null, summaryOk),
    plain: F.text(card.plain),
    brief:
      card.brief === null
        ? null
        : {
            ...F.object(F.brief(card.brief)),
            note_id: F.ref("note", card.brief.note_id),
            observed_at: F.date(card.brief.observed_at),
          },
    since: F.date(card.since),
    since_open: F.flag(card.since_open),
    since_min: F.date(card.since_min),
    as_of: F.date(card.as_of),
    // A value outside the market vocabulary is dropped (null), never thrown: one odd card must not
    // fail the whole research context.
    metrics: card.metrics.map((metric) => ({
      label: L.market(L.marketOk(metric.label) ? metric.label : null),
      text: L.market(L.marketOk(metric.text) ? metric.text : null),
    })),
    stale: F.flag(card.stale),
    missing: F.flag(card.missing),
    last_note_at: F.date(card.last_note_at),
    note_this_week: F.flag(card.note_this_week),
  }));
}
export function researchContext(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const service = ctx.store.research;
  if (service === undefined)
    throw new ToolError("native research context is unavailable", "unsupported");
  const read = ctx.store.read,
    now = R.eventInstant(new Date(ctx.store.now()).toISOString()),
    positions = service.positions().positions;
  const instruments = Q.loadInstruments(read, Q.vaultInstrumentGids(read)),
    owned = new Set(
      [...instruments].filter(([, inst]) => R.ownerNamed(inst)).map(([id]) => String(id)),
    );
  const summary = R.researchSummary(read, {
    now,
    lang: service.plans.lang,
    weights: new Map(positions.map((row) => [String(row.instrument.id), row.weight])),
  });
  const byId = new Map(summary.instruments.map((row) => [row.instrument_id, row]));
  const theses = R.thesesByInstrument(read);
  const thesis = (id: string) => {
    const row = theses.get(id);
    return row === undefined
      ? null
      : F.thesis({
          ...row,
          draft:
            row.reviewedAt === null &&
            R.DRAFT_THESIS_PREFIXES.some((prefix) => row.thesis.startsWith(prefix)),
        });
  };
  const heldIds = new Set(positions.map((row) => String(row.instrument.id)));
  const held = positions.flatMap((row) => {
    const id = String(row.instrument.id),
      research = byId.get(id);
    if (research === undefined || owned.has(id)) return [];
    return [
      {
        ...F.instrument(row.instrument, ctx),
        recommendation: F.category(row.instrument.plan),
        recommendation_at: F.date(row.instrument.plan_at),
        strength: F.category(row.instrument.strength),
        strength_basis: F.category(row.instrument.strength_basis),
        strength_at: F.date(row.instrument.strength_at),
        bucket: F.category(row.bucket),
        weight: F.percent(row.weight),
        segment: F.category(row.instrument.segment),
        segment_source: F.category(row.instrument.segment_source),
        watched: F.flag(research.watched),
        entry_type: F.category(theses.get(id)?.entryType),
        thesis: thesis(id),
        research: F.researchFields(research),
      },
    ];
  });
  const watchItems = Q.watchlist(read),
    watchedIds = new Set(watchItems.map((item) => item.instrument));
  const watched = watchItems.flatMap((item) => {
    const research = byId.get(item.instrument),
      inst = instruments.get(item.instrument);
    if (
      heldIds.has(item.instrument) ||
      research === undefined ||
      owned.has(item.instrument) ||
      inst === undefined
    )
      return [];
    return [
      {
        ...F.instrument(research.instrument, ctx),
        recommendation: F.category(inst.plan),
        recommendation_at: L.date(inst.planAt),
        strength: F.category(inst.positionStrength),
        strength_basis: F.category(inst.positionStrength === null ? null : inst.strengthBasis),
        strength_at: L.date(inst.positionStrength === null ? null : inst.strengthAt),
        item_id: F.ref("watchlist", item.gid),
        segment: F.category(research.instrument?.segment),
        segment_source: F.category(research.instrument?.segment_source),
        source: F.category(item.source),
        added_at: F.date(item.addedAt),
        note: F.text(item.note),
        entry_type: F.category(theses.get(item.instrument)?.entryType),
        thesis: thesis(item.instrument),
        research: F.researchFields(research),
      },
    ];
  });
  const candidates = R.noteRows(read, "n.kind = 'candidate'"),
    open: L.LabelledTree[] = [],
    cooldown: L.LabelledTree[] = [];
  for (const note of candidates) {
    const details = F.object(note.details),
      candidate = F.object(details.candidate),
      symbol = candidate.symbol || note.candidateKey;
    if (note.cooldownUntil !== null && note.cooldownUntil > now)
      cooldown.push({
        candidate: F.symbol(symbol),
        until: F.date(research.instantDate(note.cooldownUntil)),
      });
    else if (note.dismissedAt === null && note.expiresAt > now && !F.truthy(details.accepted_at))
      open.push({
        note_id: F.ref("note", note.gid),
        candidate: F.symbol(symbol),
        title: F.text(note.title),
        entry_type: F.category(details.entry_type),
        observed_at: F.date(R.iso(note.observedAt)),
      });
  }
  const events = R.notes(read, now)
    .flatMap((row) => {
      const details = F.object(row.details),
        when = details.event_date;
      if (
        typeof when !== "string" ||
        !when ||
        when < ctx.today ||
        (row.instrument !== null && owned.has(row.instrument))
      )
        return [];
      return [
        {
          when,
          event: F.text(details.event),
          event_date: F.date(when),
          instrument_id: F.ref("instrument", row.instrument),
          segment: F.category(row.segment),
          theme: F.text(row.theme),
          note_id: F.ref("note", row.gid),
        },
      ];
    })
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0))
    .slice(0, 30)
    .map(({ when: _when, ...row }) => row);
  const config = service.strategy.config,
    used = new Map<string, number>();
  // Only theses of the current portfolio (held or watched): a closed position's thesis stays stored
  // but is out of the research scope.
  const current = new Set([...heldIds, ...watchedIds]);
  for (const [id, row] of theses)
    if (current.has(id) && byId.has(id) && !owned.has(id))
      used.set(row.entryType, (used.get(row.entryType) ?? 0) + 1);
  const exposure = research.researchExposure(
    positions.map((row) => ({
      instrument: String(row.instrument.id),
      weight: row.weight,
      assetClass: row.instrument.asset_class,
      region: row.instrument.region,
      sector: row.instrument.sector,
    })),
    owned,
  );
  const review = Q.lastReview(read, "investments"),
    agenda = F.array(F.object(review?.stats.deck).agenda);
  const segment = segments(
      ctx,
      owned,
      positions.map((row) => ({
        id: String(row.instrument.id),
        label: row.instrument.label,
        segment: row.instrument.segment,
        weight: row.weight,
      })),
    ),
    running = R.runningRun(read, now);
  return {
    as_of: F.date(ctx.today),
    positions: held,
    watchlist: watched,
    ...segment,
    segment_catalog: research.SEGMENTS.map((row) => ({
      segment: F.category(row.key),
      label: F.category(row.label),
      group: F.category(row.group),
    })),
    macro: macro(ctx),
    macro_catalog: research.MACRO_SEGMENTS.map((row) => ({
      segment: F.category(row.key),
      label: F.category(row.label),
    })),
    strategy: {
      state: F.category(service.strategy.state),
      version: F.count(service.strategy.version?.version),
      entry_types: research.THESIS_ENTRY_TYPES.map(F.category),
      entry_types_in_use: [...used]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([entry, theses]) => ({ entry_type: F.category(entry), theses: F.count(theses) })),
      candidate_criteria: [...(config?.watchlist.values ?? [])]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([criterion, value]) => ({
          criterion: F.category(criterion),
          threshold: threshold(value, criterion, ctx.strict),
        })),
      buckets: (config?.allocation.buckets ?? []).map((bucket) => ({
        bucket: F.category(bucket.id),
        target: F.percent(config?.allocation.targets.get(bucket.id)),
        asset_classes: [...bucket.match.assetClasses].sort().map(F.category),
        tags: [...bucket.match.tags].sort().map(F.category),
        markets: [...bucket.match.mics].sort().map(F.category),
        currencies: [...bucket.match.currencies].sort().map(F.category),
        pinned_instruments: F.count(bucket.match.instrumentIds.size),
      })),
      benchmark: config?.benchmark
        ? { id: F.category(config.benchmark.id), proxy: F.symbol(config.benchmark.proxy) }
        : null,
      sections: research.strategySections(service.markdown).map((section) => ({
        section: F.category(section.kind),
        heading: F.text(section.heading),
        text: F.text(section.text),
      })),
    },
    exposure: {
      asset_classes: exposure.asset_classes.map((row) => ({
        asset_class: F.category(row.asset_class),
        weight: F.percent(row.weight),
      })),
      regions: exposure.regions.map((row) => ({
        region: F.category(row.region),
        weight: F.percent(row.weight),
      })),
      sectors: exposure.sectors.map((row) => ({
        sector: F.category(row.sector),
        weight: F.percent(row.weight),
      })),
    },
    candidates: { open, dismissed_cooldown: cooldown },
    topic_thesis_cooldown: [...R.topicCooldowns(read, now)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, until]) => ({
        segment: F.category(key),
        until: F.date(research.instantDate(until)),
      })),
    upcoming_events: events,
    owner_review:
      review === undefined
        ? null
        : {
            done_at: F.date(review.doneAt),
            notes: F.text(review.notes),
            agenda: agenda
              .filter((item) => item !== null && typeof item === "object" && !Array.isArray(item))
              .map((item) => {
                const row = F.object(item);
                return {
                  card: F.category(row.card),
                  title: F.text(row.title),
                  note: F.text(row.note),
                };
              }),
          },
    last_run: F.run(summary.last_run),
    last_done_run: F.run(R.runView(read, R.latestRun(read, "done"), now)),
    running_run_id: F.ref("run", running?.gid),
    week_starts: summary.week_starts.map(F.date),
    limits: {
      title_max: F.count(120),
      summary_max: F.count(1200),
      sources_max: F.count(research.SOURCES_MAX),
      note_ttl_days: F.count(30),
      notes_per_run: F.count(R.MAX_NOTES_PER_RUN),
      candidate_cooldown_days: F.count(research.RESEARCH_CANDIDATE_COOLDOWN_DAYS),
      weekly_instruments_max: F.count(R.WEEKLY_INSTRUMENTS_MAX),
      weekly_notes_per_instrument: F.count(R.WEEKLY_NOTES_PER_INSTRUMENT),
      segment_notes_per_week: F.count(1),
      weekly_segment_notes_max: F.count(R.WEEKLY_SEGMENT_NOTES_MAX),
      segment_summary_max: F.count(research.SEGMENT_SUMMARY_MAX),
      brief_headline_max: F.count(research.BRIEF_HEADLINE_MAX),
      brief_why_max: F.count(research.BRIEF_WHY_MAX),
      brief_items_max: F.count(research.BRIEF_ITEMS_MAX),
      brief_item_max: F.count(research.BRIEF_ITEM_MAX),
      near_duplicate_days: F.count(research.similarity.WINDOW_DAYS),
      topic_thesis_max: F.count(600),
      topic_invalidation_max: F.count(400),
    },
    boundaries: BOUNDARIES.map(L.fixedText),
    note: L.fixedText(CONTEXT_NOTE),
  };
}
