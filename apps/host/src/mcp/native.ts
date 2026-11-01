// Host adapters for the native MCP boundary. Each session is bound to one loaded vault.
import type { market } from "@cashu/domain/investments";
import {
  loadAccountLabels,
  loadGuard,
  loadNameSources,
  loadPayeeSecret,
  type NativeRuntime,
  type NativeToolStore,
  restrictivePrivacy,
  type ToolInventoryEntry,
  toolContext,
} from "@cashu/mcp";
import { runCommand, type v1 } from "@cashu/store";
import { mcpAccounts, mcpProfile } from "@cashu/store/core";
import { finishMcpCall, startMcpCall } from "@cashu/store/device";
import type { HostLog } from "../log.js";
import type { HostStores, OpenVault } from "../stores.js";

export interface NativeMcpOptions {
  readonly stores: HostStores;
  readonly vault: OpenVault;
  readonly dataDir: string;
  readonly now: () => number;
  readonly replaced: () => boolean;
  readonly log: HostLog;
  readonly inventory: readonly ToolInventoryEntry[];
  readonly prices?: market.PriceCache | null;
  readonly fxNewest?: () => string | null;
}
function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const unique = (values: readonly string[]): string[] => [...new Set(values)];
export function nativeRuntime(options: NativeMcpOptions): NativeRuntime {
  const { vault, stores, now } = options;
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
  return {
    now,
    replaced: options.replaced,
    warn: (code) => options.log.warn(code),
    policy: () => vault.queue.run(() => (options.replaced() ? undefined : policy())),
    delegation: () =>
      vault.queue.run(() => {
        if (options.replaced()) return undefined;
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
    execute: (ceiling, fn) =>
      vault.queue.run(() => {
        if (options.replaced()) return fn(undefined);
        const profile = mcpProfile(read);
        const current = policy();
        if (profile === undefined || current === undefined) return fn(undefined);
        const at = now();
        const today = localDay(at);
        const pending: v1.Envelope[] = [];
        const store: NativeToolStore = {
          read,
          profile,
          today,
          now: () => at,
          prices: options.prices ?? null,
          fxNewest: options.fxNewest?.() ?? null,
          toolInventory: options.inventory,
          run(command, input) {
            // Current core writes are one command each. A second read-dependent command needs an overlay.
            if (pending.length > 0)
              throw new Error("multiple native MCP write commands require an overlay");
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
        const context = toolContext({
          store,
          profileId,
          privacy: restrictivePrivacy(current.privacy, ceiling),
          today,
          loadGuard: () => loadGuard(read, profileId, () => loadPayeeSecret(options.dataDir)),
          loadAccountLabels: () => loadAccountLabels(read),
        });
        let committed = false;
        return fn({
          context,
          policy: current,
          commit() {
            if (committed) throw new Error("native call committed twice");
            if (options.replaced()) throw new Error("host replaced before append");
            if (pending.length > 0) vault.writer.append(pending);
            committed = true;
          },
        });
      }),
  };
}
