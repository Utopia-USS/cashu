// Small synthetic native vault fixture. Public package APIs only; no profile data or filesystem DB.
import { market } from "@cashu/domain/investments";
import {
  betterSqlite3Driver,
  builtinModules,
  type Command,
  type CommandEnv,
  createProfile,
  HybridClock,
  mintUlid,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import Database from "better-sqlite3";
import { loadAccountLabels, loadGuard } from "../providers/index.js";
import { toolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { coreTools } from "../tools/core.js";

const VAULT = "11111111111111111111111111111111";
const DEVICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export function nativeFixture(options: { vault?: string; modules?: string[] } = {}) {
  const db = new Database(":memory:");
  const vault = options.vault ?? VAULT;
  const store = Store.open({
    driver: betterSqlite3Driver(db),
    vault,
    salt: vaultSalt(new Uint8Array(32).fill(17)),
    modules: builtinModules(),
  });
  let now = Date.parse("2026-11-01T12:00:00.123Z");
  let random = 1;
  const clock = { now: () => now };
  const env: CommandEnv = {
    device: DEVICE,
    clock,
    hlc: new HybridClock(DEVICE, { physical: clock }),
    lease: { isHolder: () => true },
    random: (size) =>
      Uint8Array.from({ length: size }, () => {
        random = (random * 1664525 + 1013904223) >>> 0;
        return random >>> 24;
      }),
  };
  const run = <I, R>(command: Command<I, R>, input: unknown) =>
    runCommand(store, storeWriter(store), command, input, env);
  const created = run(createProfile, {
    slug: "synthetic",
    name: "Anna Nowak",
    baseCurrency: "PLN",
    modules: options.modules ?? ["budget", "investments"],
  });
  if (!created.ok) throw new Error(created.reason);
  const prices = new market.InMemoryPriceCache();
  let committed = 0;
  const toolStore = (): NativeToolStore => {
    const profile = mcpProfile(store.read.bind(store));
    if (!profile) throw new Error("missing synthetic profile");
    return {
      read: store.read.bind(store),
      profile,
      prices,
      fxNewest: null,
      today: "2026-11-01",
      now: clock.now,
      toolInventory: coreTools(),
      run: <I, R>(command: Command<I, R>, input: unknown) => {
        const outcome = run(command, input);
        if (outcome.ok) committed += outcome.events.length;
        return outcome;
      },
    };
  };
  const seed = (type: string, data: Record<string, unknown>, gid?: string): string => {
    const entity = gid ?? mintUlid(now, env.random);
    const result = store.applyEnvelopes([
      {
        eid: mintUlid(now, env.random),
        vault,
        device: DEVICE,
        hlc: env.hlc.tick(),
        at: new Date(now).toISOString(),
        type,
        v: 1,
        gid: entity,
        data,
      },
    ]);
    if (result.applied !== 1) throw new Error("synthetic event did not fold");
    return entity;
  };
  return {
    store,
    seed,
    db,
    env,
    prices,
    run,
    toolStore,
    vault,
    advance: (ms: number) => {
      now += ms;
    },
    committed: () => committed,
    context: (privacy = "amounts") =>
      toolContext({
        store: toolStore(),
        profileId: BigInt(`0x${vault}`),
        privacy,
        today: "2026-11-01",
        loadGuard: () =>
          loadGuard(store.read.bind(store), BigInt(`0x${vault}`), new Uint8Array(32).fill(23)),
        loadAccountLabels: () => loadAccountLabels(store.read.bind(store)),
      }),
    close: () => {
      store.detach();
      db.close();
    },
  };
}
