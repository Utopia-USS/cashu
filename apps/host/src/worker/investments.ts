/** Native services over actual loaded stores, with injected file/cache/network ownership. */

import { randomBytes } from "node:crypto";
import { parseDateTime } from "@cashu/domain";
import { performance as perf, toCurrency } from "@cashu/domain/investments";
import {
  type Command,
  type CommandEnv,
  type DurableCommandResult,
  investmentsPerformance,
  mintUlid,
  refuse,
} from "@cashu/store";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import {
  collectPriceNeeds,
  type DailyVault,
  DurableWriteUnknown,
  loadStrategy,
  PricesService,
  runDaily,
} from "@cashu/store/investments/services";
import { runHostVaultCommand } from "../commands.js";
import type { OpenVault } from "../stores.js";
import { guardedLease, WorkerAuthorityLost, workerGuard } from "./authority.js";
import type { JobOutcome, WorkerBindings, WorkerHostContext } from "./contracts.js";
import { reportSuccessfulFetch } from "./leaseReport.js";
import { localDay } from "./schedule.js";

export interface WorkerWriteAttempts {
  reserve(
    vault: OpenVault,
    job: "investments.daily" | "investments.backfill",
    command: string,
    key: string,
  ): Promise<void>;
  settle(vault: OpenVault, key: string): Promise<void>;
}

export function nativeInvestmentJobs(
  host: WorkerHostContext,
  bindings: WorkerBindings,
  attempts?: WorkerWriteAttempts,
) {
  const ports = bindings.investments;
  if (ports === undefined) return undefined;
  const prices = new PricesService(ports.dailyLock);
  const guardOf = (vault: OpenVault, ui = false, offline = false) => {
    const current = workerGuard(host, bindings, vault, "investments.daily", {
      network: !offline && bindings.offline !== true,
      ...(ui ? { ui: true } : {}),
    });
    return () => {
      current();
      if (bindings.investments !== ports) throw new WorkerAuthorityLost();
    };
  };
  const envOf = (vault: OpenVault, guard: () => void): CommandEnv => ({
    device: vault.env.device,
    clock: vault.env.clock,
    hlc: vault.env.hlc,
    lease: guardedLease(guard),
    ...(vault.env.random === undefined ? {} : { random: vault.env.random.bind(vault.env) }),
  });
  const durableOf =
    (vault: OpenVault, guard: () => void, job: "investments.daily" | "investments.backfill") =>
    async <I, R>(command: Command<I, R>, input: unknown) => {
      if (attempts === undefined)
        return { kind: "not_started" as const, reason: "worker_attempt_bookkeeping_unavailable" };
      const key = mintUlid(Date.now(), (n) => new Uint8Array(randomBytes(n)));
      try {
        await attempts.reserve(vault, job, command.id, key);
      } catch (error) {
        if (error instanceof DurableWriteUnknown) throw error;
        // A failed reservation may have reached disk. Never dispatch or mint a second key.
        throw new DurableWriteUnknown(key, command.id);
      }
      const guarded: Command<I, R> = {
        ...command,
        run(ctx, parsed) {
          try {
            guard();
          } catch {
            return refuse("worker_authority_lost");
          }
          return command.run(ctx, parsed);
        },
      };
      let result: DurableCommandResult<R>;
      try {
        result = await runHostVaultCommand(vault, guarded, input, key, () => {
          try {
            guard();
            return true;
          } catch {
            return false;
          }
        });
      } catch {
        throw new DurableWriteUnknown(key, command.id);
      }
      if (result.kind !== "outcome_unknown") {
        try {
          await attempts.settle(vault, key);
        } catch {
          // The completed result is known but its reservation may remain durable.
          throw new DurableWriteUnknown(key, command.id);
        }
      }
      return result;
    };
  return {
    async daily(
      vaults: readonly OpenVault[],
      offlineOverride = false,
    ): Promise<ReadonlyMap<string, JobOutcome>> {
      const results = new Map<string, JobOutcome>(),
        selected: DailyVault[] = [];
      for (const vault of vaults) {
        try {
          const guard = guardOf(vault, false, offlineOverride);
          guard();
          const files = ports.files(vault);
          if (files === null) {
            results.set(vault.id, { status: "skipped", code: "file_authority_unavailable" });
            continue;
          }
          selected.push({
            store: vault.store,
            writer: vault.writer,
            env: envOf(vault, guard),
            files,
            enabled: enabledModuleIds(vault.store.read.bind(vault.store)).has("investments"),
            lang: bindings.language(vault),
            runWrite: (work) =>
              vault.queue.run(() => {
                guard();
                return work();
              }),
            ...(vault.native === undefined
              ? {}
              : { durableWrite: durableOf(vault, guard, "investments.daily") }),
          });
        } catch (error) {
          results.set(vault.id, {
            status: error instanceof WorkerAuthorityLost ? "skipped" : "failed",
            code: error instanceof WorkerAuthorityLost ? "authority_lost" : "preparation_failed",
          });
        }
      }
      if (selected.length === 0) return results;
      const sources = ports.sources?.bind(ports);
      const offline = offlineOverride || bindings.offline === true;
      const report = await runDaily(
        {
          vaults: selected,
          lock: ports.dailyLock,
          prices: ports.prices,
          ...(ports.marketForVault === undefined ? {} : { marketForVault: ports.marketForVault }),
          ...(sources === undefined ? {} : { sources }),
          ...(ports.activity === undefined ? {} : { activity: ports.activity }),
          ...(ports.notifications === undefined ? {} : { notifications: ports.notifications }),
          ...(ports.macroStore === undefined ? {} : { macroStore: ports.macroStore }),
        },
        { asOf: localDay(host.now()), trigger: "worker", offline },
      );
      for (const vault of vaults) {
        const fetched = report.market?.reports.get(vault.id);
        if (
          fetched?.instruments.some((item) => item.status === "ok" && item.start !== null) ||
          fetched?.fx.some((item) => item.status === "ok" && item.start !== null)
        )
          await reportSuccessfulFetch(vault, guardOf(vault));
      }
      if (report.status === "busy")
        for (const vault of selected)
          results.set(vault.store.vault, { status: "skipped", code: "busy" });
      for (const row of report.profiles)
        results.set(row.vault, {
          status: row.status === "refused" ? "skipped" : row.status,
          ...(row.error === undefined
            ? {}
            : { code: row.status === "refused" ? "authority_lost" : "daily_failed" }),
          ...(row.result === undefined
            ? {}
            : {
                stats: {
                  new_signals: row.result.newSignals.length,
                  escalated_signals: row.result.escalatedSignals.length,
                },
              }),
        });
      return results;
    },
    backfillEnabled: () => bindings.offline !== true && ports.sources !== undefined,
    async backfill(vault: OpenVault): Promise<"finished" | "failed" | "busy" | "unavailable"> {
      if (bindings.offline || ports.sources === undefined) return "unavailable";
      const guard = guardOf(vault);
      guard();
      if (!host.networkEnabled()) throw new WorkerAuthorityLost();
      const files = ports.files(vault);
      if (files === null) return "unavailable";
      const state = await loadStrategy(vault.store, files);
      guard();
      const config = state.config,
        read = vault.store.read.bind(vault.store),
        profile = mcpProfile(read);
      if (profile === undefined) return "unavailable";
      const sources = ports.sources([vault.id]);
      try {
        const result = await investmentsPerformance.runBackfill({
          store: vault.store,
          writer: vault.writer,
          env: envOf(vault, guard),
          cache: ports.prices,
          sources: { prices: sources.priceSource, fx: sources.fxSource },
          strategy: {
            state: state.state,
            benchmark: config?.benchmark ?? null,
            policy: config?.data ?? perf.DEFAULT_VALUATION_POLICY,
            strategy:
              config === null
                ? null
                : { baseCurrency: config.baseCurrency, allocation: config.allocation },
          },
          asOf: localDay(host.now()),
          profile: profile.slug,
          isCurrent: () => {
            guard();
            return host.networkEnabled();
          },
          runWrite: (work) =>
            vault.queue.run(() => {
              guard();
              return work();
            }),
          ...(vault.native === undefined
            ? {}
            : { durableWrite: durableOf(vault, guard, "investments.backfill") }),
        });
        guard();
        if (!result.ok && result.reason === "not_leader") throw new WorkerAuthorityLost();
        if (!result.ok) return "busy";
        if (
          [...result.value.instruments, ...result.value.benchmarks, ...result.value.fx].some(
            (row) => row.status === "ok",
          )
        )
          await reportSuccessfulFetch(vault, guard);
        return [...result.value.instruments, ...result.value.benchmarks, ...result.value.fx].some(
          (row) => row.status === "error",
        )
          ? "failed"
          : "finished";
      } finally {
        sources.close();
      }
    },
    async prices(vault: OpenVault): Promise<"finished" | "busy"> {
      const guard = guardOf(vault, true);
      guard();
      if (bindings.offline || !host.networkEnabled() || ports.sources === undefined) return "busy";
      const files = ports.files(vault);
      if (files === null) return "busy";
      // Same read-only strategy load as Python prices.price_needs, without version recording.
      const strategy = await loadStrategy(vault.store, files);
      guard();
      const needs = await vault.queue.run(() => {
        guard();
        const profile = mcpProfile(vault.store.read.bind(vault.store));
        if (profile === undefined) throw new WorkerAuthorityLost();
        return collectPriceNeeds(
          vault.store.read.bind(vault.store),
          localDay(host.now()),
          parseDateTime(new Date(host.now()).toISOString()),
          strategy.config?.baseCurrency ?? toCurrency(profile.baseCurrency),
        );
      });
      guard();
      const sources = ports.sources([vault.id]);
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          sources.close();
        }
      };
      try {
        const result = await prices.run({
          vault: { vault: vault.id, needs, authority: guardedLease(guard) },
          enabled: true,
          prices: ports.prices,
          asOf: localDay(host.now()),
          clock: () => parseDateTime(new Date(host.now()).toISOString()),
          close,
          priceSource: sources.priceSource,
          fxSource: sources.fxSource,
          ...(sources.spark === undefined ? {} : { spark: sources.spark }),
          ...(sources.tableFx === undefined ? {} : { tableFx: sources.tableFx }),
          ...(sources.workers === undefined ? {} : { workers: sources.workers }),
        });
        guard();
        if (result.status === "ok" && (result.updated > 0 || result.fxUpdated > 0))
          await reportSuccessfulFetch(vault, guard);
        return result.status === "busy" || result.status === "refused" ? "busy" : "finished";
      } finally {
        close();
      }
    },
  };
}
