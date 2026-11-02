/** Native read-only review assembly over the same portfolio/performance/research services. */
import {
  addDays,
  D,
  type DateTime,
  floatRepr,
  type IsoDate,
  parseDateTime,
  toStorage,
  toUtc,
  utcIso,
} from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import {
  InMemoryFxLookup,
  instrumentLabel,
  type ProfileId,
  performance as perf,
  preloadRates,
  research,
  views,
} from "@cashu/domain/investments";
import * as macro from "@cashu/domain/investments/macro";
import type { Read } from "../../core/queries.js";
import type { Store } from "../../materialize.js";
import { type MarketInput, resolveMarketInput } from "../marketInput.js";
import { PerformanceService } from "../performance/service.js";
import { importBatches } from "../queries/import-preview.js";
import { loadInstruments } from "../queries/instruments.js";
import { decisionSignalGids, decisions } from "../queries/journal.js";
import { lastReview } from "../queries/reviews.js";
import { lastGoodRunGid, ruleRuns, signalByGid } from "../queries/signals.js";
import { strategyVersions } from "../queries/strategy.js";
import { viewInstant } from "../research/rows.js";
import { segmentsView } from "../research/segments.js";
import { researchDigest } from "../research/views.js";
import type { StrategyState } from "../services/strategy.js";
import { allSignalFacts } from "./facts.js";
import { portfolioAt } from "./portfolio.js";
import { newestFirst } from "./stableOrder.js";

const { reviewDigestView } = views;
type DigestDecision = views.DigestDecision;
type DigestFlows = views.DigestFlows;
type ReviewClock = views.ReviewClock;
type ViewClock = views.ViewClock;

/** Clock conversion stays outside the pure domain and never consults the process clock/locale. */
export function makeReviewClock(clock: ViewClock): ReviewClock {
  const parts = (at: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: clock.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
  const fields = (at: number) =>
    Object.fromEntries(parts(at).map((part) => [part.type, part.value]));
  const epoch = (at: DateTime | string) => new Date(utcIso(at)).getTime();
  return {
    now: clock.now,
    today: clock.today,
    localDate(at) {
      const f = fields(epoch(at));
      return `${f.year}-${f.month}-${f.day}` as IsoDate;
    },
    midnight(day) {
      const nominal = new Date(`${day}T00:00:00Z`).getTime();
      let value = nominal;
      // Resolve the wall midnight through the injected zone, including a DST offset change.
      for (let i = 0; i < 3; i++) {
        const f = fields(value);
        const wall = Date.UTC(
          Number(f.year),
          Number(f.month) - 1,
          Number(f.day),
          Number(f.hour),
          Number(f.minute),
          Number(f.second),
        );
        const next = nominal - (wall - value);
        if (next === value) break;
        value = next;
      }
      return parseDateTime(new Date(value).toISOString());
    },
  };
}

export type ReviewDigestRequest = MarketInput & {
  readonly vault: ProfileId;
  readonly clock: ViewClock;
  readonly strategy: StrategyState;
  readonly lang: UiLang;
  readonly since?: IsoDate | null;
  /** Raw device-local public closes. Refresh/persistence is an S22c responsibility. */
  readonly macroCloses: macro.MacroCloses;
  readonly performance?: PerformanceService;
};

function performanceStrategy(state: StrategyState): perf.PerformanceStrategy {
  const config = state.config;
  return {
    state: state.state,
    benchmark: config?.benchmark ?? null,
    policy:
      config === null
        ? perf.DEFAULT_VALUATION_POLICY
        : { maxPriceAgeDays: config.data.maxPriceAgeDays, maxFxAgeDays: config.data.maxFxAgeDays },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
}

function flows(
  input: MarketInput & {
    readonly current: Parameters<typeof reviewDigestView>[0]["current"];
    readonly since: IsoDate;
    readonly computed: perf.ComputedPerformance | null;
  },
): DigestFlows {
  const { current, since } = input;
  const computed =
    input.computed !== null && perf.hasHistory(input.computed) ? input.computed : null;
  const base = current.base;
  const cached = resolveMarketInput(input, current.instruments.values());
  const currencies = new Set([base, ...current.txns.map((txn) => txn.cashCurrency)]);
  const oldest = current.txns.reduce(
    (day, txn) => (txn.tradeDate < day ? txn.tradeDate : day),
    current.asOf,
  );
  const lookup = new InMemoryFxLookup(
    preloadRates(
      [...currencies].flatMap((currency) => cached.fxRates(currency)),
      currencies,
      current.asOf,
      oldest,
    ),
  );
  const rate = (
    currency: Parameters<perf.ComputedPerformance["inputs"]["fx"]["rateOnOrBefore"]>[0],
    day: IsoDate,
  ) => (currency === base ? D("1") : lookup.rateOnOrBefore(currency, day, base));
  let contributions: ReturnType<typeof D> | null = D("0"),
    transfers: ReturnType<typeof D> | null = D("0");
  for (const txn of current.txns) {
    if (!(since < txn.tradeDate && txn.tradeDate <= current.asOf)) continue;
    if (txn.type === "deposit" || txn.type === "withdrawal") {
      const fx = rate(txn.cashCurrency, txn.tradeDate);
      contributions =
        fx === null || contributions === null ? null : contributions.add(txn.cashAmount.mul(fx));
    } else if (
      txn.type === "transfer_in" ||
      txn.type === "transfer_out" ||
      txn.type === "adjustment"
    ) {
      if (txn.instrumentId !== null && txn.quantity !== null && !txn.quantity.isZero()) {
        const value = computed?.series.txnValues.get(txn.id) ?? null;
        transfers =
          value === null || transfers === null
            ? null
            : transfers.add(txn.type === "transfer_out" ? value.neg() : value);
      } else {
        const fx = rate(txn.cashCurrency, txn.tradeDate);
        transfers =
          fx === null || transfers === null ? null : transfers.add(txn.cashAmount.mul(fx));
      }
    }
  }
  let implied = D("0");
  if (transfers === null) return { contributions, transfers, implied };
  if (computed !== null) {
    const combined = perf.combineSeries(computed.series);
    for (let i = 0; i < computed.series.dates.length; i++) {
      const day = computed.series.dates[i] as IsoDate;
      const gap = combined.implied[i] ?? 0;
      if (since < day && day <= current.asOf && gap) implied = implied.add(D(floatRepr(gap)));
    }
  }
  return { contributions, transfers, implied };
}

/** No result cache: clock-only changes recompute episode visibility, periods, research and schedules. */
export function reviewDigestInputs(store: Store, request: ReviewDigestRequest) {
  const read: Read = store.read.bind(store);
  const marketInput: MarketInput =
    request.marketData === undefined
      ? { prices: request.prices }
      : { marketData: request.marketData };
  const clock = makeReviewClock(request.clock);
  const currentResult = portfolioAt(read, {
    vault: request.vault,
    asOf: clock.today,
    ...marketInput,
    strategy: request.strategy,
    lang: request.lang,
  });
  if (!currentResult.ok) return currentResult;
  const current = currentResult.value;
  const last = lastReview(read, "investments") ?? null;
  const baseline =
    request.since != null
      ? ("since" as const)
      : last !== null
        ? ("review" as const)
        : ("default_7d" as const);
  const sinceAt =
    request.since != null
      ? clock.midnight(request.since)
      : last !== null
        ? parseDateTime(last.doneAt)
        : { ...toUtc(clock.now), date: addDays(toUtc(clock.now).date, -7) };
  const local = clock.localDate(sinceAt);
  const since = local < current.asOf ? local : current.asOf;
  const previousResult = current.txns.some((txn) => txn.tradeDate <= since)
    ? portfolioAt(read, {
        vault: request.vault,
        asOf: since,
        ...marketInput,
        strategy: request.strategy,
        lang: request.lang,
      })
    : null;
  const previous = previousResult?.ok ? previousResult.value : null;
  const journal = decisions(read);
  const linked = decisionSignalGids(
    read,
    journal.map((row) => row.gid),
  );
  const decisionFacts: DigestDecision[] = journal.map((row) => ({
    id: row.gid,
    signal: row.signal,
    signals: linked.get(row.gid) ?? [],
    instrument: row.instrument,
    account: row.account,
    action: row.action,
    quantity: row.quantity === null ? null : D(row.quantity),
    price: row.price === null ? null : D(row.price),
    currency: row.currency,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
  const batches = newestFirst(read, "imports", importBatches(read), (row) => row.createdAt);
  const runs = ruleRuns(read, Number.MAX_SAFE_INTEGER);
  const signalFacts = allSignalFacts(read);
  const labelIds = signalFacts.flatMap((row) =>
    row.instrumentId === null ? [] : [row.instrumentId],
  );
  const labels = new Map<string, string>(
    [...loadInstruments(read, labelIds)].map(([id, instrument]) => [
      id,
      instrumentLabel(instrument),
    ]),
  );
  let computed: perf.ComputedPerformance | null = null;
  try {
    computed = (request.performance ?? new PerformanceService()).computed(store, {
      asOf: current.asOf,
      strategy: performanceStrategy(request.strategy),
      ...marketInput,
    });
  } catch {
    /* Python's digest answers when attribution is unavailable. */
  }
  const now = viewInstant(toStorage(clock.now));
  let segmentFacts: ReturnType<typeof research.digestSegments> | null = null;
  let segmentTrends: research.Trends | null = null;
  if (computed !== null) {
    try {
      const projected = segmentsView(read, {
        computed,
        ...marketInput,
        now,
        lang: request.lang,
        window: "1w",
      });
      if (projected.ok) {
        segmentFacts = research.digestSegments(projected.value);
        segmentTrends = projected.trends;
      }
    } catch {
      /* Attribution is best-effort in the source contract. */
    }
  }
  const startInstant = viewInstant(toStorage(sinceAt));
  const utcStart = toUtc(sinceAt).date;
  const utcNow = toUtc(clock.now).date;
  const macroStart = utcStart < utcNow ? utcStart : utcNow;
  const changes = macro.macroChanges(
    macro.evaluate(request.macroCloses, current.asOf),
    macroStart,
    current.asOf,
    request.lang,
  );
  const digestResearch = researchDigest(read, {
    now,
    since: startInstant,
    ...(segmentFacts === null ? {} : { segments: segmentFacts }),
    macroChanges: changes,
  });
  const versions = strategyVersions(read);
  const priceMoveBars = current.historyBars;
  return {
    ok: true as const,
    segmentTrends,
    value: {
      current,
      previous,
      clock,
      lang: request.lang,
      period: { since, sinceAt: toStorage(sinceAt), baseline },
      lastReview: last,
      signals: signalFacts,
      decisions: decisionFacts,
      imports: batches.map((row) => ({
        id: row.gid,
        account: row.account,
        importer: row.importer,
        broker: row.broker,
        fileName: row.fileName,
        sha256: row.fileSha256,
        inserted: row.txnCount,
        duplicates: row.duplicateCount,
        positions: row.positionCount,
        renames: row.renameCount,
        statusChanges: row.statusChangeCount,
        newInstruments: row.instrumentCount,
        corrections: row.correctionCount,
        warnings: row.warnings.length,
        createdAt: row.createdAt,
      })),
      runs: runs.map((row) => ({
        id: row.gid,
        startedAt: row.startedAt,
        status: row.status,
        errors: row.errors,
        escalated: Array.isArray(row.report.escalated)
          ? row.report.escalated.flatMap((id) => {
              if (typeof id !== "string") return [];
              const signal = signalByGid(read, id);
              return signal === undefined ? [] : [signal.gid];
            })
          : [],
      })),
      labels,
      goodRun: lastGoodRunGid(read) ?? null,
      flows:
        previous === null
          ? { contributions: null, transfers: null, implied: D("0") }
          : flows({ current, since, computed, ...marketInput }),
      strategyVersion: request.strategy.version?.version ?? null,
      strategyState: request.strategy.state,
      strategyVersionDates: versions.map((row) => row.createdAt),
      research: digestResearch,
      priceMoveBars,
    } satisfies views.ReviewDigestInput,
  } as const;
}

export function readReviewDigest(store: Store, request: ReviewDigestRequest) {
  const input = reviewDigestInputs(store, request);
  return input.ok ? { ok: true as const, value: reviewDigestView(input.value) } : input;
}
