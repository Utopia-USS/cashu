/** Synthetic real-host fixtures shared only by worker proofs. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  type Command,
  investmentsCommands,
  investmentsLocal,
  runCommand,
  setModules,
} from "@cashu/store";
import { DailyPriceLock } from "@cashu/store/investments/services";
import { startLocalHost } from "../host.js";
import type { HostStores, OpenVault } from "../stores.js";
import type { WorkerBindings, WorkerHostContext, WorkerJob } from "../worker/contracts.js";
import { localDay } from "../worker/schedule.js";
import { privateWorkerState } from "../worker/state.js";
import { tempDir, testHostOptions } from "./harness.js";
import { testStrategyDirs } from "./strategyDirs.js";

export async function seedWorkerHolding(vault: OpenVault, time: number): Promise<string> {
  const account = await command(vault, investmentsCommands.addBrokerageAccount, {
    name: "Synthetic worker account",
    broker: "dif",
  });
  const instrument = await command(vault, investmentsCommands.createInstrument, {
    name: "Synthetic held equity",
    symbol: "SYN",
    mic: "XWAR",
    assetClass: "equity",
    currency: "PLN",
    aliases: [{ namespace: "yahoo", value: "SYN.WA", guessed: false }],
  });
  await command(vault, investmentsCommands.addToWatchlist, { target: { stored: instrument.gid } });
  await command(vault, investmentsCommands.addManualTransaction, {
    account: account.account,
    type: "deposit",
    tradeDate: localDay(time),
    cashAmount: "100",
    currency: "PLN",
  });
  await command(vault, investmentsCommands.addManualTransaction, {
    account: account.account,
    instrument: instrument.gid,
    type: "buy",
    tradeDate: localDay(time),
    quantity: "10",
    price: "10",
    currency: "PLN",
  });
  return instrument.gid;
}

export async function command<I, R>(
  vault: OpenVault,
  cmd: Command<I, R>,
  input: unknown,
): Promise<R> {
  const result = await vault.queue.run(() =>
    runCommand(vault.store, vault.writer, cmd, input, vault.env),
  );
  if (!result.ok) throw new Error(`synthetic command refused: ${result.reason}`);
  return result.value;
}
export async function workerFixture(
  options: {
    readonly two?: boolean;
    readonly modules?: readonly string[];
    readonly yaml?: string | null;
  } = {},
) {
  const hosts = await Promise.all(
    Array.from({ length: options.two ? 2 : 1 }, () =>
      startLocalHost({ ...testHostOptions(tempDir()), launcher: false }),
    ),
  );
  const vaults = hosts.flatMap((h) => [...h.stores.vaults.values()]);
  const first = hosts[0];
  if (first === undefined) throw new Error("synthetic host absent");
  for (const vault of vaults)
    await command(vault, setModules, { moduleIds: options.modules ?? ["investments", "budget"] });
  const map = new Map(vaults.map((v) => [v.id, v]));
  const stores: HostStores = {
    device: first.stores.device,
    vaults: map,
    recovered: 0,
    pending: () => hosts.reduce((n, h) => n + h.stores.pending(), 0),
    invalidate: () => {},
    drain: async () => {
      await Promise.all(hosts.map((h) => h.stores.drain()));
    },
    close: () => {
      for (const host of hosts) host.stores.close();
    },
  };
  const driver = openNodeSqlite(":memory:");
  const prices = new investmentsLocal.SqlPriceCache(driver),
    notifications = new investmentsLocal.NotificationQueue(driver);
  const day = new Date();
  day.setHours(8, 0, 0, 0);
  let time = day.getTime(),
    current = true,
    jobs = true,
    network = true;
  const holders = new Set(vaults.map((v) => v.id));
  const owned = new Set<WorkerJob>(["investments.daily", "budget.sync", "notifications", "digest"]);
  const directory = join(tempDir(), "worker");
  mkdirSync(directory, { mode: 0o700 });
  const state = privateWorkerState(directory, () => current);
  const strategyDirs = testStrategyDirs(options.yaml);

  const context: WorkerHostContext = {
    stores,
    now: () => time,
    isCurrent: (vault) => current && map.get(vault.id) === vault,
    jobsEnabled: () => jobs,
    networkEnabled: () => network,
    uiCount: () => hosts.reduce((n, h) => n + h.server.sessionCounts().ui, 0),
  };
  const bindings: WorkerBindings = {
    state,
    ownership: { isExclusive: (job) => owned.has(job) },
    authority: (vault) => ({ isHolder: () => holders.has(vault.id) }),
    language: () => "en",
    offline: true,
    investments: {
      prices,
      notifications,
      dailyLock: new DailyPriceLock(),
      files: strategyDirs.files,
      strategySync: strategyDirs.strategySync,
    },
  };
  return {
    hosts,
    vaults,
    strategyDirs,
    context,
    bindings,
    prices,
    notifications,
    holders,
    owned,
    directory,
    time: () => time,
    setTime: (value: number) => {
      time = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    revoke: () => {
      current = false;
    },
    jobs: (enabled: boolean) => {
      jobs = enabled;
    },
    network: (enabled: boolean) => {
      network = enabled;
    },
    close: async () => {
      current = false;
      await Promise.all(hosts.map((h) => h.stop()));
      driver.close();
    },
  };
}
