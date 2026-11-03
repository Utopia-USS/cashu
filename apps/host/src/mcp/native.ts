// Host adapters for the native MCP boundary. Each session is bound to one loaded vault.

import { randomBytes } from "node:crypto";
import type { market } from "@cashu/domain/investments";
import {
  type InvestmentAsyncCapabilities,
  type InvestmentHistoryReads,
  type InvestmentReads,
  type InvestmentWriteServices,
  loadAccountLabels,
  loadGuard,
  loadNameSources,
  loadPayeeSecret,
  type NativeExecution,
  type NativeRuntime,
  type NativeToolStore,
  type ResearchServices,
  restrictivePrivacy,
  type ToolContext,
  ToolError,
  type ToolInventoryEntry,
  toolContext,
} from "@cashu/mcp";
import { mintUlid, runCommand, type v1 } from "@cashu/store";
import { mcpAccounts, mcpProfile } from "@cashu/store/core";
import { finishMcpCall, startMcpCall } from "@cashu/store/device";
import { runHostVaultCommand } from "../commands.js";
import type { HostLog } from "../log.js";
import type { HostStores, OpenVault } from "../stores.js";

export interface NativeMcpOptions {
  readonly investmentAsync?: InvestmentAsyncCapabilities;
  readonly stores: HostStores;
  readonly vault: OpenVault;
  readonly dataDir: string;
  readonly now: () => number;
  readonly replaced: () => boolean;
  readonly log: HostLog;
  readonly inventory: readonly ToolInventoryEntry[];
  readonly prices?: market.PriceCache | null;
  readonly fxNewest?: () => string | null;
  readonly investmentReads?: (context: ToolContext<NativeToolStore>) => InvestmentReads;
  readonly investmentHistory?: (context: ToolContext<NativeToolStore>) => InvestmentHistoryReads;
  readonly research?: (context: ToolContext<NativeToolStore>) => ResearchServices;
  readonly investmentWrites?: (context: ToolContext<NativeToolStore>) => InvestmentWriteServices;
  readonly readInvestmentImportFile?: (
    path: string,
    slug: string,
  ) => { readonly name: string; readonly bytes: Uint8Array };
  readonly readInvestmentMappingFile?: (path: string, slug: string) => string;
  readonly readBudgetImportFile?: (
    rawPath: string,
    profileSlug: string,
  ) => {
    readonly name: string;
    readonly bytes: Uint8Array;
  };
}
function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const unique = (values: readonly string[]): string[] => [...new Set(values)];
export function nativeRuntime(options: NativeMcpOptions): NativeRuntime {
  const { vault, stores, now } = options;
  const readBudgetImportFile = options.readBudgetImportFile;
  const readInvestmentImportFile = options.readInvestmentImportFile;
  const readInvestmentMappingFile = options.readInvestmentMappingFile;
  const read = vault.store.read.bind(vault.store);
  const policy = () => {
    const profile = mcpProfile(read);
    return profile === undefined
      ? undefined
      : {
          privacy: profile.mcpPrivacy === "amounts" ? ("amounts" as const) : ("strict" as const),
          modules: new Set(profile.modules),
        };
  };
  const execute = async <T>(
    ceiling: Parameters<NativeRuntime["execute"]>[0],
    fn: (execution: NativeExecution | undefined) => T | Promise<T>,
    requestKey?: string,
    preparation = false,
  ): Promise<T> =>
    await (vault.native === undefined
      ? vault.queue.run.bind(vault.queue)
      : <V>(task: () => V) => Promise.resolve().then(task))(() => {
      const complete = (value: T | Promise<T>): T | Promise<T> => {
        if (
          preparation &&
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value
        ) {
          void Promise.resolve(value).catch(() => {
            try {
              options.log.warn("mcp.prepare-callback-failed");
            } catch {
              /* diagnostic only */
            }
          });
          throw new Error("native preparation callbacks must be synchronous");
        }
        return value;
      };
      if (
        options.replaced() ||
        stores.vaults.get(vault.id) !== vault ||
        (vault.native !== undefined && !vault.native.isCurrent())
      )
        return complete(fn(undefined));
      const profile = mcpProfile(read);
      const current = policy();
      if (profile === undefined || current === undefined) return complete(fn(undefined));
      const profileSlug = profile.slug;
      const currentForIo = () => {
        if (
          options.replaced() ||
          stores.vaults.get(vault.id) !== vault ||
          (vault.native !== undefined && !vault.native.isCurrent())
        )
          return false;
        try {
          const freshProfile = mcpProfile(read);
          const fresh = policy();
          return (
            freshProfile?.slug === profileSlug &&
            fresh !== undefined &&
            fresh.privacy === current.privacy &&
            fresh.modules.size === current.modules.size &&
            [...current.modules].every((module) => fresh.modules.has(module))
          );
        } catch {
          return false;
        }
      };
      const currentForWrite = () => active && vault.native !== undefined && currentForIo();
      const at = now();
      const today = localDay(at);
      const pending: v1.Envelope[] = [];
      let ran = false;
      let writePending = false;
      let writeCompleted = false;
      let writeUncertain = false;
      let dispatchedKey: string | undefined;
      let active = true;
      const assertContextCurrent = () => {
        if (
          !active ||
          options.replaced() ||
          stores.vaults.get(vault.id) !== vault ||
          (vault.native !== undefined && !currentForWrite())
        )
          throw new Error("native MCP context is no longer active");
      };
      const scopedRead: typeof read = (...args) => {
        assertContextCurrent();
        return read(...args);
      };
      let context: ToolContext<NativeToolStore>;
      let research: ResearchServices | undefined;
      let researchResolved = false;
      let investmentWrites: InvestmentWriteServices | undefined;
      let investmentWritesResolved = false;
      const store: NativeToolStore = {
        read: scopedRead,
        get investmentAsync() {
          assertContextCurrent();
          const candidate = options.investmentAsync;
          if (
            candidate &&
            (candidate.vault !== vault.id ||
              (candidate.search && candidate.search.vault !== vault.id) ||
              (candidate.watch && candidate.watch.vault !== vault.id) ||
              (candidate.imports && candidate.imports.vault !== vault.id))
          )
            throw new Error("native async vault binding is inconsistent");
          return candidate;
        },
        profile,
        today,
        now: () => at,
        prices: options.prices ?? null,
        fxNewest: options.fxNewest?.() ?? null,
        toolInventory: options.inventory,
        get investmentWrites() {
          assertContextCurrent();
          if (!investmentWritesResolved) {
            const candidate = options.investmentWrites?.(context);
            if (
              candidate !== undefined &&
              (candidate.vault !== vault.store.vault ||
                candidate.plans.vault !== vault.store.vault ||
                (candidate.strategyFiles !== undefined &&
                  candidate.strategyFiles.vault !== vault.store.vault))
            )
              throw new Error("native investment-write vault binding is inconsistent");
            investmentWrites = candidate;
            investmentWritesResolved = true;
          }
          return investmentWrites;
        },
        get research() {
          assertContextCurrent();
          if (!researchResolved) {
            const candidate = options.research?.(context);
            if (
              candidate !== undefined &&
              (candidate.vault !== vault.store.vault || candidate.plans.vault !== vault.store.vault)
            )
              throw new Error("native research vault binding is inconsistent");
            research = candidate;
            researchResolved = true;
          }
          return research;
        },
        get investments() {
          assertContextCurrent();
          return options.investmentReads?.(context);
        },
        get investmentHistory() {
          assertContextCurrent();
          return options.investmentHistory?.(context);
        },
        ...(readInvestmentImportFile === undefined
          ? {}
          : {
              readInvestmentImportFile: (path: string) => {
                if (!currentForIo()) throw new Error("native MCP import authority changed");
                if (readInvestmentImportFile === undefined) throw new Error("missing file reader");
                return readInvestmentImportFile(path, profileSlug);
              },
            }),
        ...(readInvestmentMappingFile === undefined
          ? {}
          : {
              readInvestmentMappingFile: (path: string) => {
                if (!currentForIo()) throw new Error("native MCP mapping authority changed");
                if (readInvestmentMappingFile === undefined)
                  throw new Error("missing mapping reader");
                return readInvestmentMappingFile(path, profileSlug);
              },
            }),
        ...(readBudgetImportFile === undefined
          ? {}
          : {
              readBudgetImportFile: (rawPath: string) => {
                assertContextCurrent();
                return readBudgetImportFile(rawPath, profileSlug);
              },
            }),
        run(command, input) {
          if (preparation) throw new Error("native preparation cannot write");
          assertContextCurrent();
          if (ran) throw new Error("multiple native MCP write commands require an overlay");
          ran = true;
          if (vault.native !== undefined) {
            writePending = true;
            writeUncertain = true;
            const key = requestKey ?? mintUlid(now(), (n) => new Uint8Array(randomBytes(n)));
            dispatchedKey = key;
            return runHostVaultCommand(vault, command, input, key, currentForWrite)
              .then((outcome) => {
                const result = outcome;
                if (result.kind === "completed") {
                  writeCompleted = true;
                  writeUncertain = false;
                  return { ok: true as const, value: result.value };
                }
                if (result.kind === "outcome_unknown")
                  throw new ToolError(
                    "write outcome unknown; inspect the original key",
                    "outcome_unknown",
                    { system: true, requestKey: result.key },
                  );
                if (result.reason === "request_key_conflict")
                  throw new ToolError(
                    "this key belongs to an earlier write; inspect its original status",
                    "outcome_unknown",
                    { system: true, requestKey: key },
                  );
                writeUncertain = false;
                return { ok: false as const, reason: result.reason };
              })
              .catch((error) => {
                if (error instanceof ToolError && error.kind === "outcome_unknown") throw error;
                throw new ToolError(
                  "write outcome unknown; inspect the original key",
                  "outcome_unknown",
                  { system: true, requestKey: key },
                );
              })
              .finally(() => {
                writePending = false;
              });
          }
          return runCommand(
            vault.store,
            { append: (events) => pending.push(...events) },
            command,
            input,
            { ...vault.env, clock: { now: () => at } },
          );
        },
      };
      const profileId = BigInt(`0x${vault.id}`);
      context = toolContext({
        store,
        profileId,
        privacy: restrictivePrivacy(current.privacy, ceiling),
        today,
        loadGuard: () => loadGuard(scopedRead, profileId, () => loadPayeeSecret(options.dataDir)),
        loadAccountLabels: () => loadAccountLabels(scopedRead),
      });
      let committed = false;
      try {
        const result = complete(
          fn({
            context,
            policy: current,
            hasWritten: () => writeCompleted,
            writeKey: () => dispatchedKey,
            uncertainWriteKey: () => (writeUncertain ? dispatchedKey : undefined),
            commit() {
              if (committed) throw new Error("native call committed twice");
              if (preparation) throw new Error("native preparation cannot commit");
              assertContextCurrent();
              if (writePending) throw new Error("native MCP write was not awaited");
              if (options.replaced() || stores.vaults.get(vault.id) !== vault)
                throw new Error("host replaced before append");
              if (vault.native === undefined && pending.length > 0) vault.writer.append(pending);
              committed = true;
            },
          }),
        );
        return Promise.resolve(result).finally(() => {
          active = false;
        });
      } catch (error) {
        active = false;
        throw error;
      }
    });
  return {
    now,
    replaced: options.replaced,
    warn: (code) => options.log.warn(code),
    policy: () =>
      vault.queue.run(() =>
        options.replaced() ||
        stores.vaults.get(vault.id) !== vault ||
        (vault.native !== undefined && !vault.native.isCurrent())
          ? undefined
          : policy(),
      ),
    ...(vault.native === undefined
      ? {}
      : {
          writeStatus: (key: string) =>
            vault.queue
              .run(async () => {
                if (
                  options.replaced() ||
                  stores.vaults.get(vault.id) !== vault ||
                  !vault.native?.isCurrent() ||
                  policy() === undefined
                )
                  return { kind: "outcome_unknown" as const };
                try {
                  const status = await vault.native.attempts.lookup(vault.id, key);
                  if (status.phase === "completed") return { kind: "completed" as const };
                  if (status.phase === "terminal") return status.result;
                  return { kind: "outcome_unknown" as const };
                } catch {
                  return { kind: "outcome_unknown" as const };
                }
              })
              .catch(() => ({ kind: "outcome_unknown" as const })),
        }),
    delegation: () =>
      vault.queue.run(() => {
        if (
          options.replaced() ||
          stores.vaults.get(vault.id) !== vault ||
          (vault.native !== undefined && !vault.native.isCurrent())
        )
          return undefined;
        const current = policy();
        const profile = mcpProfile(read);
        if (!current || !profile) return undefined;
        const providers = loadNameSources(read);
        return {
          ...current,
          names: {
            persons: unique([
              ...mcpAccounts(read).flatMap((account) => (account.name ? [account.name] : [])),
              ...providers.flatMap((provider) => [...provider.persons]),
            ]),
            strongNames: unique([
              profile.name,
              ...providers.flatMap((provider) => [...(provider.strongNames ?? [])]),
            ]),
            privatePayees: unique(providers.flatMap((provider) => [...provider.privatePayees])),
            strictNames: unique(
              providers.flatMap((provider) =>
                [...(provider.strictAliases ?? [])].map(([origin]) => origin),
              ),
            ),
          },
        };
      }),
    audit: {
      start: (tool, args) =>
        stores.device.queue.run(() => {
          if (options.replaced()) throw new Error("host replaced before audit");
          const outcome = stores.device.store.run(startMcpCall, {
            vault: vault.id,
            tool,
            args,
            calledAt: new Date(now()).toISOString(),
          });
          if (!outcome.ok) throw new Error("audit start refused");
          return outcome.value.id;
        }),
      finish: (id, privacy, outcome, errorKind, durationMs) =>
        stores.device.queue.run(() => {
          if (options.replaced()) return;
          const result = stores.device.store.run(finishMcpCall, {
            id,
            vault: vault.id,
            privacy,
            outcome,
            errorKind,
            durationMs,
          });
          if (!result.ok) throw new Error("audit finish refused");
        }),
    },
    execute,
    preparations: {
      execute: (ceiling, fn) =>
        execute(
          ceiling,
          (execution) =>
            fn(
              execution === undefined
                ? undefined
                : { context: execution.context, policy: execution.policy },
            ),
          undefined,
          true,
        ),
    },
  };
}
