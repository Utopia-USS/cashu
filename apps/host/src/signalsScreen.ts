/** Owner Signals async effects. The renderer sends intent, never resolved instruments or source. */

import { isDeepStrictEqual } from "node:util";
import { parseDateTime, toStorage } from "@cashu/domain";
import { AliasNamespace, market } from "@cashu/domain/investments";
import { defineCommand, investmentsCommands, mintUlid, refuse } from "@cashu/store";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { investmentEntityIdSchema } from "@cashu/store/investments/screen-sources";
import {
  addWatchWithPlans,
  InstrumentSearch,
  type InstrumentSearchSources,
  needsWatchIo,
  prepareWatchResolution,
  projectInstrumentSearch,
  type ResearchPlanInputs,
  removeWatchWithPlans,
  type WatchAddRequest,
  type WatchlistMarket,
  type WatchResolution,
  type WatchResolutionAnswers,
} from "@cashu/store/investments/services";
import type {
  SignalsWatchResult,
  SignalsWatchTarget,
} from "@cashu/store/investments/signals-screen";
import type { ChangeSource } from "@cashu/store/query";
import { z } from "zod";
import { defineUiAction, unknownUiCommand } from "./uiActions.js";

type WatchAddResult = Omit<Extract<SignalsWatchResult, { ok: true }>["value"], "warnings">;

/** Open-host clock notifications update effective statuses without changing Suspense query keys. */
export function signalsScreenClock(now: () => number): {
  current(): { now: ReturnType<typeof parseDateTime>; timeZone: string };
  changes: ChangeSource;
} {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const changes: ChangeSource = {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === null)
        timer = setInterval(() => {
          for (const notify of listeners) notify();
        }, 30_000);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
  return {
    current: () => ({
      now: parseDateTime(new Date(now()).toISOString()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    changes,
  };
}

export function signalsScreenToday(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Own remote answers before another async phase can mutate the provider's arrays. */
export function snapshotWatchHits(hits: readonly market.SearchHit[]): readonly market.SearchHit[] {
  return hits.map((hit) => ({ ...hit, market: hit.market === null ? null : { ...hit.market } }));
}
export function snapshotWatchQuote(live: market.ChartQuote | null): market.ChartQuote | null {
  return live === null
    ? null
    : {
        ...live,
        bars: live.bars.map((bar) => ({ ...bar })),
        splits: live.splits.map((split) => ({ ...split })),
        adjusted: live.adjusted.map(([date, close]) => [date, close] as const),
      };
}

const gid = investmentEntityIdSchema;
const watchInput = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("instrument"), gid }),
    z.strictObject({
      kind: z.literal("pick"),
      yahooSymbol: z.string().min(1).max(40),
      ticker: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      assetClass: z.string().nullable().optional(),
      mic: z.string().nullable().optional(),
      isin: z.string().nullable().optional(),
    }),
    z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(120) }),
  ]),
  note: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
});
const searchInput = z.strictObject({ query: z.string().min(1).max(60) });
const snoozeInput = z.strictObject({ signal: gid, until: z.string().nullable() });
const removeInput = z.strictObject({ item: gid });

export interface SignalsScreenCapability {
  readonly vault: string;
  readonly generation: string;
  isCurrent(): boolean;
  /** Public lookup provider, independent of MCP sessions. */
  readonly searchSources?: () => InstrumentSearchSources;
  readonly watchMarket?: WatchlistMarket;
  /**
   * Obtains fresh fetch-lease pull evidence before the public ports above are read (production:
   * ./fetchAuthority.ts); they are absent while the vault may not fetch.
   */
  refreshFetch?(): Promise<unknown>;
  /** Genuine current plan inputs, if the holder can derive signals in the same batch. */
  planInputs?(): ResearchPlanInputs | undefined;
  readonly notifications?: NotificationQueue;
  /** Optional device-local cache for verified public quote bars. */
  readonly prices?: market.PriceCache;
}

/** A vault's public-market ports for Signals (online instrument search, pick verification). */
export interface SignalsMarketPorts {
  isCurrent(): boolean;
  readonly searchSources?: () => InstrumentSearchSources;
  readonly watchMarket?: WatchlistMarket;
}

function requestOf(
  target: SignalsWatchTarget,
  today: string,
  note?: string | null,
  tags?: readonly string[] | null,
): WatchAddRequest {
  const resolved =
    target.kind === "instrument"
      ? { instrument: target.gid }
      : target.kind === "pick"
        ? {
            pick: {
              yahooSymbol: target.yahooSymbol,
              ticker: target.ticker,
              name: target.name,
              assetClass: target.assetClass,
              mic: target.mic,
              isin: target.isin,
            },
          }
        : { text: target.text };
  return {
    target: resolved,
    today,
    ...(note === undefined ? {} : { note }),
    ...(tags === undefined ? {} : { tags }),
    source: "user",
    keepExistingNote: false,
  };
}

export function signalsScreenActions(options: {
  bind(vault: string): SignalsScreenCapability | null;
  now(): number;
  timeZone(): string;
}) {
  const today = () => signalsScreenToday(options.now(), options.timeZone());
  const search = new InstrumentSearch(options.now);
  const binding = (vault: string) => {
    const cap = options.bind(vault);
    return cap === null || cap.vault !== vault || !cap.isCurrent()
      ? null
      : {
          generation: cap.generation,
          capabilities: cap,
          isCurrent: () => cap.isCurrent() && options.bind(vault) === cap,
        };
  };
  const prepared = new Map<
    string,
    { request: WatchAddRequest; answers: WatchResolutionAnswers; resolution: WatchResolution }
  >();
  const addCommand = defineCommand({
    id: "investments.signals.watchResolved",
    input: investmentsCommands.addToWatchlist.input,
    run(ctx, input) {
      const cap = options.bind(ctx.vault);
      if (cap === null || !cap.isCurrent()) return refuse("capability_unavailable");
      return addWatchWithPlans(cap.planInputs?.()).run(ctx, input);
    },
  });
  const removeCommand = defineCommand({
    id: "investments.signals.removeWatchResolved",
    input: investmentsCommands.removeFromWatchlist.input,
    run(ctx, input) {
      const cap = options.bind(ctx.vault);
      if (cap === null || !cap.isCurrent()) return refuse("capability_unavailable");
      return removeWatchWithPlans(cap.planInputs?.()).run(ctx, input);
    },
  });
  const snoozeCommand = defineCommand({
    id: "investments.signals.snoozeOwner",
    input: investmentsCommands.snoozeSignalCommand.input,
    run(ctx, input) {
      if (input.until !== null) {
        try {
          if (toStorage(parseDateTime(input.until)) <= toStorage(parseDateTime(ctx.now())))
            return refuse("snooze_not_future");
        } catch {
          return refuse("invalid_until");
        }
      }
      return investmentsCommands.snoozeSignalCommand.run(ctx, input);
    },
  });
  const watch = defineUiAction<
    z.infer<typeof watchInput>,
    SignalsScreenCapability,
    SignalsWatchResult
  >({
    id: "investments.signals.watch",
    module: "investments",
    input: watchInput,
    bind: binding,
    commands: [addCommand],
    beforeExecute(read, step) {
      const saved = prepared.get(step.key);
      if (saved === undefined || saved.request.today !== today()) return false;
      const current = prepareWatchResolution(read, saved.request, saved.answers);
      return current.ok && isDeepStrictEqual(current.value, saved.resolution);
    },
    async run(context, input) {
      await context.capabilities.refreshFetch?.();
      const request = requestOf(input.target, today(), input.note, input.tags);
      let answers: WatchResolutionAnswers = context.capabilities.watchMarket
        ? {}
        : { unavailable: true };
      for (let phase = 0; phase <= 2; phase++) {
        const result = await context.readStep((read) =>
          prepareWatchResolution(read, request, answers),
        );
        if (result.ok) {
          const resolution = result.value;
          const key = mintUlid(options.now());
          prepared.set(key, { request, answers, resolution });
          try {
            const target =
              resolution.kind === "stored"
                ? { stored: resolution.instrument }
                : {
                    planned: resolution.planned,
                    ...(resolution.yahooSymbol === null
                      ? {}
                      : { yahooSymbol: resolution.yahooSymbol }),
                  };
            const save = await context.execute({
              command: addCommand.id,
              input: {
                target,
                source: "user",
                keepExistingNote: false,
                ...(input.note === undefined ? {} : { note: input.note }),
                ...(input.tags === undefined ? {} : { tags: input.tags }),
              },
              key,
            });
            if (save.kind === "outcome_unknown") return unknownUiCommand(save, addCommand.id);
            if (save.kind === "not_started")
              return { status: "not_started" as const, reason: "capability_unavailable" as const };
            if (save.kind === "refused")
              return {
                status: "completed" as const,
                value: { ok: false as const, reason: save.reason, params: {} },
              };
            const value = save.value as WatchAddResult;
            let cacheStatus: "not_applicable" | "published" | "unconfirmed" = "not_applicable";
            if (
              value.createdInstrument &&
              resolution.kind === "planned" &&
              resolution.quote !== null &&
              resolution.yahooSymbol !== null
            ) {
              if (!context.isCurrent() || context.capabilities.prices === undefined)
                cacheStatus = "unconfirmed";
              else {
                try {
                  context.capabilities.prices.upsertBars(
                    market.marketSymbol(AliasNamespace.YAHOO, resolution.yahooSymbol),
                    resolution.quote.bars.map((bar) => ({
                      date: bar.date,
                      close: bar.close,
                      open: bar.open,
                      high: bar.high,
                      low: bar.low,
                      volume: bar.volume,
                      currency: bar.currency,
                      fetchedAt: bar.fetchedAt,
                    })),
                    parseDateTime(new Date(options.now()).toISOString()),
                  );
                  cacheStatus = "published";
                } catch {
                  cacheStatus = "unconfirmed";
                }
              }
            }
            return {
              status: "completed" as const,
              value: {
                ok: true as const,
                value: {
                  ...value,
                  cacheStatus,
                  warnings:
                    value.createdInstrument && resolution.kind === "planned"
                      ? resolution.warnings
                      : [],
                },
              },
            };
          } finally {
            prepared.delete(key);
          }
        }
        if (!needsWatchIo(result)) return { status: "completed" as const, value: result };
        if (phase === 2)
          return {
            status: "refused" as const,
            reason: "remote_phase_limit",
            preparation: "none" as const,
          };
        const port = context.capabilities.watchMarket;
        if (port === undefined) {
          answers = { unavailable: true };
          continue;
        }
        if (result.operation.kind === "search") {
          let hits: Awaited<ReturnType<WatchlistMarket["search"]>> = [];
          try {
            hits = snapshotWatchHits(await port.search(result.operation.query));
          } catch {
            answers = { unavailable: true };
            continue;
          }
          answers = { ...answers, search: { query: result.operation.query, hits } };
        } else {
          let quote: Awaited<ReturnType<WatchlistMarket["chart"]>> = null;
          try {
            const live = await port.chart(
              result.operation.symbol,
              result.operation.start,
              result.operation.end,
            );
            quote = snapshotWatchQuote(live);
          } catch {
            /* preserve unverified fallback */
          }
          answers = { ...answers, chart: { symbol: result.operation.symbol, quote } };
        }
      }
      return {
        status: "refused" as const,
        reason: "remote_phase_limit",
        preparation: "none" as const,
      };
    },
  });
  const lookup = defineUiAction({
    id: "investments.signals.search",
    module: "investments",
    input: searchInput,
    bind: binding,
    async run(context, input) {
      let answer: {
        hits: Awaited<ReturnType<InstrumentSearch["remoteHits"]>>["hits"];
        status: "skipped" | "unavailable" | "ok";
      } = { hits: [], status: "unavailable" };
      await context.capabilities.refreshFetch?.();
      if (context.capabilities.searchSources)
        answer = await search.remoteHits(input.query, context.capabilities.searchSources);
      const value = await context.readStep((read) =>
        projectInstrumentSearch({ read, asOf: today() }, input.query, {}, answer),
      );
      return { status: "completed", value };
    },
  });
  const remove = defineUiAction<z.infer<typeof removeInput>, SignalsScreenCapability, unknown>({
    id: "investments.signals.removeWatch",
    module: "investments",
    input: removeInput,
    bind: binding,
    commands: [removeCommand],
    async run(context, input) {
      const saved = await context.execute({
        command: removeCommand.id,
        input,
        key: mintUlid(options.now()),
      });
      if (saved.kind === "outcome_unknown") return unknownUiCommand(saved, removeCommand.id);
      if (saved.kind === "not_started")
        return { status: "not_started", reason: "capability_unavailable" };
      return saved.kind === "completed"
        ? { status: "completed", value: saved.value }
        : { status: "refused", reason: saved.reason, preparation: "none" };
    },
  });
  const snooze = defineUiAction<
    z.infer<typeof snoozeInput>,
    SignalsScreenCapability,
    { status: "saved" | "saved_cleanup_unconfirmed"; signal: string; dropped: number | null }
  >({
    id: "investments.signals.snooze",
    module: "investments",
    input: snoozeInput,
    bind: binding,
    commands: [snoozeCommand],
    async run(context, input) {
      const saved = await context.execute({
        command: snoozeCommand.id,
        input,
        key: mintUlid(options.now()),
      });
      if (saved.kind === "outcome_unknown") return unknownUiCommand(saved, snoozeCommand.id);
      if (saved.kind === "not_started")
        return { status: "not_started", reason: "capability_unavailable" };
      if (saved.kind === "refused")
        return { status: "refused", reason: saved.reason, preparation: "none" };
      const value = saved.value as { signal: string };
      if (input.until === null)
        return {
          status: "completed",
          value: { status: "saved", signal: value.signal, dropped: null },
        };
      if (!context.isCurrent())
        return {
          status: "completed",
          value: { status: "saved_cleanup_unconfirmed", signal: value.signal, dropped: null },
        };
      try {
        const queue = context.capabilities.notifications;
        if (queue === undefined)
          return {
            status: "completed",
            value: { status: "saved_cleanup_unconfirmed", signal: value.signal, dropped: null },
          };
        const dropped = queue.dropUnsent(context.vault, value.signal);
        return { status: "completed", value: { status: "saved", signal: value.signal, dropped } };
      } catch {
        return {
          status: "completed",
          value: { status: "saved_cleanup_unconfirmed", signal: value.signal, dropped: null },
        };
      }
    },
  });
  return [lookup, watch, remove, snooze] as const;
}
