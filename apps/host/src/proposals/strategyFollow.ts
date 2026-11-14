// This device's strategy files follow the recorded version (store `syncStrategyFiles`): the host
// side. A genuine local edit is recorded and a conflicting one becomes an owner proposal through the
// vault's durable write path; the caller holds the daily lock so a follow never overlaps a daily
// run or an approval's publication. Used before an approval is prepared, by the Strategies tab's
// reload, and in the background after a sync pass brings another device's version.
import { type Command, investmentsCommands, mintUlid } from "@cashu/store";
import { createProposal } from "@cashu/store/core";
import {
  type DailyPriceLock,
  type StrategyFileSyncPorts,
  type StrategyFileSyncResult,
  syncStrategyFiles,
} from "@cashu/store/investments/services";
import { runHostVaultCommand } from "../commands.js";
import type { HostStores, OpenVault } from "../stores.js";
import { strategyPublicationPorts } from "./strategyFiles.js";

/** A durable write outcome the follower cannot continue past. */
class StrategyFollowInterrupted extends Error {
  readonly key: string;
  readonly command: string;
  constructor(key: string, command: string) {
    super("strategy_follow_outcome_unknown");
    this.key = key;
    this.command = command;
  }
}

/** Run one follow pass for `vault` over `ports` (the caller holds the daily lock). */
export async function followVaultStrategy(
  vault: OpenVault,
  ports: StrategyFileSyncPorts,
  isCurrent: () => boolean,
): Promise<StrategyFileSyncResult> {
  const write = async <I, R>(command: Command<I, R>, input: I) => {
    const out = await runHostVaultCommand(vault, command, input, mintUlid(Date.now()), isCurrent);
    if (out.kind === "completed") return out.value;
    if (out.kind === "outcome_unknown") throw new StrategyFollowInterrupted(out.key, command.id);
    throw new Error(out.reason);
  };
  return syncStrategyFiles({
    store: vault.store,
    files: ports.files,
    journal: ports.journal,
    isVaultCurrent: isCurrent,
    record: (input) => write(investmentsCommands.saveStrategyVersion, input),
    propose: async (input) => {
      await write(createProposal, input);
    },
  });
}

/**
 * Background follower: after every settled sync pass of an open native vault (and once at start),
 * bring this device's strategy files to the recorded version. A pass that finds the daily lock
 * held (a daily run or an approval is working on the files) is retried after the next sync.
 */
export function startStrategyFollower(input: {
  readonly stores: HostStores;
  readonly dailyLock: DailyPriceLock;
  readonly onError?: (vault: string, error: unknown) => void;
}): { close(): void; settled(): Promise<void> } {
  let closed = false;
  const running = new Map<OpenVault, Promise<void>>();
  const again = new Set<OpenVault>();
  const stops: (() => void)[] = [];
  const pass = (vault: OpenVault) => {
    if (closed) return;
    if (running.has(vault)) {
      again.add(vault);
      return;
    }
    const work = (async () => {
      const authority = vault.native?.strategyDirectoryAuthority() ?? null;
      if (authority === null || authority.vault !== vault.id) return;
      const isCurrent = () =>
        !closed &&
        input.stores.vaults.get(vault.id) === vault &&
        vault.native?.isCurrent() === true &&
        authority.isCurrent();
      if (!isCurrent()) return;
      const release = input.dailyLock.tryAcquire();
      if (release === null) return;
      try {
        await followVaultStrategy(vault, strategyPublicationPorts(authority), isCurrent);
      } finally {
        release();
      }
    })()
      .catch((error: unknown) => input.onError?.(vault.id, error))
      .finally(() => {
        running.delete(vault);
        if (again.delete(vault)) pass(vault);
      });
    running.set(vault, work);
  };
  for (const vault of input.stores.vaults.values()) {
    if (vault.native === undefined) continue;
    stops.push(vault.native.onSyncSettled(() => pass(vault)));
    pass(vault);
  }
  return {
    close() {
      closed = true;
      for (const stop of stops.splice(0)) stop();
    },
    async settled() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}
