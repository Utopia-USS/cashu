/** Injection-only daily orchestration. Host authority/lifecycle registration remains S40/S56. */
import { addDays, type DateTime, parseDateTime } from "@cashu/domain";
import { Currencies, type market, toCurrency } from "@cashu/domain/investments";
import {
  BACKFILL_DAYS,
  type MacroChartSource,
  type MacroReport,
  type MacroStats,
  refreshMacro,
} from "@cashu/domain/investments/macro";
import { z } from "zod";
import {
  type CommandEnv,
  defineCommand,
  type EventWriter,
  ok,
  refuse,
  runCommand,
} from "../../command.js";
import { profileOf } from "../../core/queries.js";
import { mintUlid } from "../../gid.js";
import type { Store } from "../../materialize.js";
import type { Read } from "../../query.js";
import { type DailyEvaluationResult, dailyEvaluation } from "../commands/daily.js";
import type { NotificationQueue } from "../local/notificationQueue.js";
import type { LocalRunStatus } from "../local/runStatus.js";
import type { MarketInput } from "../marketInput.js";
import { type DurableWrite, DurableWriteUnknown, requireDurable } from "./durable.js";
import { collectPriceNeeds } from "./priceNeeds.js";
import { type DailyPriceLock, type RefreshPriceDeps, refreshPriceNeeds } from "./prices.js";
import { loadStrategy, type StrategyFilesPort, type StrategyState } from "./strategy.js";
import type { StrategyFileSyncPorts } from "./strategyFileSync.js";

export interface DailyVault {
  readonly store: Store;
  readonly writer: EventWriter;
  readonly env: CommandEnv;
  readonly files: StrategyFilesPort;
  /** The device's strategy files and private journal: they follow the recorded version first. */
  readonly sync: StrategyFileSyncPorts;
  readonly enabled: boolean;
  readonly lang: "pl" | "en";
  /** Existing per-vault host queue, bound by the caller. Never surrounds file or network awaits. */
  runWrite<T>(work: () => T): Promise<T>;
  readonly durableWrite?: DurableWrite;
}
export interface DailyProfileResult {
  readonly vault: string;
  readonly status: "ok" | "partial" | "failed" | "refused";
  readonly result?: DailyEvaluationResult;
  readonly error?: string;
}
export interface DailySources
  extends Pick<
    RefreshPriceDeps,
    "priceSource" | "fxSource" | "spark" | "tableFx" | "workers" | "scoped"
  > {
  close(): void;
  readonly macro?: MacroChartSource | null;
}
export async function runDaily(
  deps: {
    readonly vaults: readonly DailyVault[];
    readonly lock: DailyPriceLock;
    readonly prices: market.PriceCache;
    readonly marketForVault?: (read: Read, vault: string) => MarketInput;
    readonly sources?: (vaultIds: readonly string[]) => DailySources;
    readonly activity?: LocalRunStatus;
    readonly notifications?: NotificationQueue;
    /** Local macro cache writes belong to an explicitly injected short transaction adapter. */
    readonly macroStore?: { apply(report: MacroReport, now: DateTime): MacroStats };
  },
  input: {
    readonly asOf: string;
    readonly trigger: string;
    readonly offline?: boolean;
    /** Explicit selection follows Python: selected profiles need not have the module enabled. */
    readonly vaults?: readonly string[];
  },
): Promise<{
  status: "ran" | "busy";
  profiles: readonly DailyProfileResult[];
  market?: Awaited<ReturnType<typeof refreshPriceNeeds>>;
  macro?: MacroReport;
  macroError?: string;
}> {
  const release = deps.lock.tryAcquire();
  if (release === null) return { status: "busy", profiles: [] };
  const profiles: DailyProfileResult[] = [];
  let sources: DailySources | undefined;
  try {
    const wanted = input.vaults === undefined ? null : new Set(input.vaults);
    const selected = deps.vaults.filter((v) =>
      wanted === null ? v.enabled : wanted.has(v.store.vault),
    );
    const ready: {
      v: DailyVault;
      strategy: StrategyState;
      startedAt: string;
      needs: ReturnType<typeof collectPriceNeeds>;
    }[] = [];
    for (const v of selected) {
      if (!v.env.lease.isHolder()) {
        profiles.push({ vault: v.store.vault, status: "refused", error: "not_leader" });
        continue;
      }
      const startedAt = new Date(v.env.clock.now()).toISOString();
      try {
        deps.activity?.started(v.store.vault, startedAt);
        // File I/O and version recording precede all market I/O. No write queue spans an await.
        const strategy = await loadStrategy(v.store, v.files, {
          record: true,
          writer: v.writer,
          env: v.env,
          sync: v.sync,
          beforeRecord: () => v.env.lease.isHolder(),
          runWrite: (work) => v.runWrite(work),
          ...(v.durableWrite === undefined ? {} : { durableWrite: v.durableWrite }),
        });
        if (!v.env.lease.isHolder()) throw new Error("not_leader");
        const profile = profileOf(v.store.read.bind(v.store));
        if (!profile) throw new Error("missing_profile");
        const needs = collectPriceNeeds(
          v.store.read.bind(v.store),
          input.asOf,
          parseDateTime(startedAt),
          strategy.config?.baseCurrency ?? toCurrency(profile.baseCurrency),
        );
        ready.push({ v, strategy, startedAt, needs });
      } catch (error) {
        if (error instanceof DurableWriteUnknown) {
          error.vault = v.store.vault;
          try {
            deps.activity?.finished(v.store.vault, startedAt);
          } catch {
            // Device-local bookkeeping cannot replace the original durable key.
          }
          throw error;
        }
        profiles.push({ vault: v.store.vault, status: "failed", error: "preparation_failed" });
        deps.activity?.finished(v.store.vault, startedAt);
      }
    }
    let refreshed: Awaited<ReturnType<typeof refreshPriceNeeds>> | undefined;
    let refreshError: string | undefined;
    let macroReport: MacroReport | undefined;
    let macroError: string | undefined;
    let macroWork: Promise<void> | null = null;
    let runMacro: (() => Promise<void>) | undefined;
    if (!input.offline && deps.sources && ready.some(({ v }) => v.env.lease.isHolder())) {
      try {
        sources = deps.sources(ready.map(({ v }) => v.store.vault));
        const activeSources = sources;
        const hasConsumer = () => ready.some(({ v }) => v.env.lease.isHolder());
        const macroSource = activeSources.macro;
        const macroPhase = async () => {
          if (!macroSource) return;
          try {
            macroReport = await refreshMacro(
              {
                async chart(...args) {
                  if (!hasConsumer()) throw new Error("not_leader");
                  const result = await macroSource.chart(...args);
                  if (!hasConsumer()) throw new Error("not_leader");
                  return result;
                },
              },
              input.asOf,
            );
          } catch (error) {
            macroError =
              error instanceof Error ? `${error.name}: ${error.message}` : "unknown failure";
          }
        };
        runMacro = macroPhase;
        macroWork = (activeSources.workers ?? 1) > 1 ? macroPhase() : null;
        const first = ready[0];
        if (first)
          refreshed = await refreshPriceNeeds({
            ...sources,
            prices: deps.prices,
            vaults: ready.map(({ v, needs }) => {
              const windowStart = addDays(input.asOf, -BACKFILL_DAYS);
              const oldestUsd = needs.fxHistoryFrom.get(Currencies.USD);
              return {
                vault: v.store.vault,
                needs: macroSource
                  ? {
                      ...needs,
                      currencies: new Set([...needs.currencies, Currencies.USD]),
                      fxHistoryFrom: new Map([
                        ...needs.fxHistoryFrom,
                        [
                          Currencies.USD,
                          oldestUsd !== undefined && oldestUsd < windowStart
                            ? oldestUsd
                            : windowStart,
                        ],
                      ]),
                    }
                  : needs,
                authority: v.env.lease,
              };
            }),
            asOf: input.asOf,
            now: parseDateTime(new Date(first.v.env.clock.now()).toISOString()),
          });
      } catch (error) {
        refreshError =
          error instanceof Error ? `${error.name}: ${error.message}` : "unknown failure";
      } finally {
        if (macroWork) await macroWork;
        else await runMacro?.();
        try {
          sources?.close();
        } catch (error) {
          refreshError ??=
            error instanceof Error ? `${error.name}: ${error.message}` : "source close failed";
        }
        sources = undefined;
      }
    }
    if (macroReport && ready.some(({ v }) => v.env.lease.isHolder())) {
      try {
        const first = ready[0];
        if (!deps.macroStore || !first) throw new Error("macro_store_unavailable");
        deps.macroStore.apply(
          macroReport,
          parseDateTime(new Date(first.v.env.clock.now()).toISOString()),
        );
      } catch (error) {
        macroError =
          error instanceof Error ? `${error.name}: ${error.message}` : "macro write failed";
      }
    }
    for (const { v, strategy, startedAt, needs } of ready) {
      try {
        if (!v.env.lease.isHolder()) {
          profiles.push({ vault: v.store.vault, status: "refused", error: "not_leader" });
          continue;
        }
        const report = refreshed?.reports.get(v.store.vault);
        const errors = refreshError ? [`market refresh failed: ${refreshError}`] : [];
        for (const item of report?.instruments ?? [])
          if (item.status === "error" && needs.instruments.has(item.instrumentId))
            errors.push(`prices ${item.label}: ${item.message}`);
        for (const fx of report?.fx ?? [])
          if (fx.status === "error" && needs.currencies.has(fx.currency))
            errors.push(`fx ${fx.currency}: ${fx.message}`);
        const command = dailyEvaluation({
          strategy,
          market: deps.marketForVault?.(v.store.read.bind(v.store), v.store.vault) ?? {
            prices: deps.prices,
          },
          lang: v.lang,
          marketErrors: errors,
          notificationKnown: (signal, severity) =>
            deps.notifications?.has(v.store.vault, signal, severity) ?? false,
          watchedPriceErrors:
            report?.instruments
              .filter((r) => needs.watched.has(r.instrumentId) && r.status === "error")
              .map((r) => `prices ${r.label}: ${r.message}`) ?? [],
        });
        const out = v.durableWrite
          ? await v.durableWrite(command, {
              asOf: input.asOf,
              trigger: input.trigger,
              preparedId: mintUlid(v.env.clock.now(), v.env.random),
            })
          : await v.runWrite(() => {
              if (!v.env.lease.isHolder()) return refuse("not_leader");
              return runCommand(
                v.store,
                v.writer,
                command,
                { asOf: input.asOf, trigger: input.trigger },
                v.env,
              );
            });
        if ("kind" in out && out.kind === "outcome_unknown")
          throw new DurableWriteUnknown(out.key, command.id);
        if (("kind" in out && out.kind !== "completed") || ("ok" in out && !out.ok)) {
          profiles.push({ vault: v.store.vault, status: "refused", error: out.reason });
          continue;
        }
        const value = out.value;
        profiles.push({ vault: v.store.vault, status: value.status, result: value });
        // This is deliberately after append. A crash here can lose enqueue intent; no durability
        // equivalence is claimed without an approved intent protocol.
        if (deps.notifications) {
          try {
            for (const intent of value.notificationIntents) {
              deps.notifications.enqueue(
                v.store.vault,
                intent.signal,
                intent.severity,
                intent.createdAt,
              );
            }
          } catch {
            profiles[profiles.length - 1] = {
              ...(profiles[profiles.length - 1] as DailyProfileResult),
              error: "notification_enqueue_failed",
            };
          }
        }
      } catch (error) {
        if (error instanceof DurableWriteUnknown) {
          error.vault = v.store.vault;
          throw error;
        }
        const failed = defineCommand({
          id: "investments.dailyFailed",
          input: z.object({
            asOf: z.string(),
            trigger: z.string(),
            strategyVersion: z.string().nullable(),
            startedAt: z.string(),
          }),
          run(ctx, failure) {
            if (!ctx.lease.isHolder()) return refuse("not_leader");
            const run = ctx.newGid();
            ctx.emit("ruleRun.finished", run, {
              trigger: failure.trigger,
              asOf: failure.asOf,
              status: "failed",
              strategyVersion: failure.strategyVersion,
              stats: {},
              errors: ["evaluation_failed"],
              report: { new: [], escalated: [] },
              startedAt: failure.startedAt,
              finishedAt: ctx.now(),
            });
            return ok({ run });
          },
        });
        // A failed final append is a failed vault run. A second append can also fail; never mask it
        // as an accepted partial financial batch or stop another vault's independent evaluation.
        try {
          const failedInput = {
            asOf: input.asOf,
            trigger: input.trigger,
            strategyVersion: strategy.version?.gid ?? null,
            startedAt,
          };
          if (v.durableWrite) await requireDurable(v.durableWrite, failed, failedInput);
          else
            await v.runWrite(() => {
              if (!v.env.lease.isHolder()) return refuse("not_leader");
              return runCommand(v.store, v.writer, failed, failedInput, v.env);
            });
        } catch (failure) {
          if (failure instanceof DurableWriteUnknown) {
            failure.vault = v.store.vault;
            throw failure;
          }
          /* Report failure below. */
        }
        profiles.push({ vault: v.store.vault, status: "failed", error: "evaluation_failed" });
      } finally {
        deps.activity?.finished(v.store.vault, startedAt);
      }
    }
    return {
      status: "ran",
      profiles,
      ...(refreshed ? { market: refreshed } : {}),
      ...(macroReport ? { macro: macroReport } : {}),
      ...(macroError ? { macroError } : {}),
    };
  } finally {
    try {
      sources?.close();
    } finally {
      release();
    }
  }
}
