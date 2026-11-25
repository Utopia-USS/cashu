// Live-query re-runs off the write path: with a scheduler a command returns before any woken query
// re-runs, a burst of applies re-runs each woken query once, a query whose tables did not change does
// not re-run, and a hold defers every re-run to one run at its release. Real in-memory stores.
import { renameProfile } from "@cashu/store";
import { defineQuery } from "@cashu/store/query";
import { expect, it } from "vitest";
import { memoryStores, VAULT_A } from "../testing/memory.js";
import { createRerunScheduler } from "./reruns.js";
import { createSyncClient } from "./sync.js";

function setup() {
  const memory = memoryStores();
  const queued: (() => void)[] = [];
  const reruns = createRerunScheduler({ schedule: (run) => queued.push(run) });
  const client = createSyncClient(memory, { lingerMs: 0, reruns });
  const runs = { name: 0, modules: 0 };
  const name = defineQuery({
    id: "test.rerunsName",
    run: (read) => {
      runs.name += 1;
      return read<{ name: string }>("SELECT name FROM profiles")[0]?.name ?? null;
    },
  });
  const modules = defineQuery({
    id: "test.rerunsModules",
    run: (read) => {
      runs.modules += 1;
      return read<{ n: number }>("SELECT count(*) AS n FROM profile_modules")[0]?.n ?? 0;
    },
  });
  const target = { kind: "vault", vault: VAULT_A } as const;
  const watch = <R>(entry: { subscribe(f: () => void): () => void; getSnapshot(): R }) => {
    const stop = entry.subscribe(() => {});
    return { stop, value: () => entry.getSnapshot() };
  };
  const drain = () => {
    while (queued.length > 0) queued.shift()?.();
  };
  return { memory, reruns, client, runs, name, modules, target, watch, drain, queued };
}

it("returns from a command before the woken queries re-run, then re-runs them once", async () => {
  const t = setup();
  const name = t.watch(t.client.entry(t.target, t.name, undefined));
  const mods = t.watch(t.client.entry(t.target, t.modules, undefined));
  expect(name.value()).toEqual({ status: "value", value: "Ala" });
  expect(t.runs).toEqual({ name: 1, modules: 1 });

  const outcome = await t.client.run(t.target, renameProfile, { name: "Ela" });
  expect(outcome).toMatchObject({ kind: "completed" });
  // Applied, not re-run yet: the reader still shows the last value.
  expect(t.runs.name).toBe(1);
  expect(name.value()).toEqual({ status: "value", value: "Ala" });
  expect(t.reruns.pending).toBe(1);

  // A burst: three more renames before the scheduled flush re-run the name query once.
  for (const n of ["Ula", "Iza", "Ewa"]) await t.client.run(t.target, renameProfile, { name: n });
  expect(t.queued).toHaveLength(1);
  t.drain();
  expect(t.runs.name).toBe(2);
  expect(name.value()).toEqual({ status: "value", value: "Ewa" });
  // The modules query read no table the renames touched: never re-run.
  expect(t.runs.modules).toBe(1);
  expect(mods.value()).toEqual({ status: "value", value: 0 });
  name.stop();
  mods.stop();
  t.client.dispose();
  t.memory.close();
});

it("defers every re-run while held and runs each once at the last release", async () => {
  const t = setup();
  const name = t.watch(t.client.entry(t.target, t.name, undefined));
  const first = t.reruns.hold();
  const second = t.reruns.hold();
  for (const n of ["Ula", "Iza"]) await t.client.run(t.target, renameProfile, { name: n });
  t.drain();
  t.reruns.flush();
  expect(t.runs.name).toBe(1);
  first();
  first(); // a second call of one release does nothing
  t.drain();
  t.reruns.flush();
  expect(t.runs.name).toBe(1);
  second();
  t.drain();
  expect(t.runs.name).toBe(2);
  expect(name.value()).toEqual({ status: "value", value: "Iza" });
  name.stop();
  t.client.dispose();
  t.memory.close();
});

it("drops the due re-run of a query that stopped", async () => {
  const t = setup();
  const name = t.watch(t.client.entry(t.target, t.name, undefined));
  await t.client.run(t.target, renameProfile, { name: "Ula" });
  expect(t.reruns.pending).toBe(1);
  name.stop();
  // lingerMs 0: the entry releases on a timer; the live query stops with it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(t.reruns.pending).toBe(0);
  t.drain();
  expect(t.runs.name).toBe(1);
  t.client.dispose();
  t.memory.close();
});

it("runs the cheapest due re-runs first and yields after a slice", () => {
  let clock = 0;
  const queued: (() => void)[] = [];
  const reruns = createRerunScheduler({
    schedule: (run) => queued.push(run),
    sliceMs: 8,
    now: () => clock,
  });
  const listeners: ((touched: ReadonlySet<string>) => void)[] = [];
  const source = reruns.wrap({
    read: () => [],
    tablesRead: () => new Set(),
    subscribe: (_tables, listener) => {
      listeners.push(listener);
      return () => {};
    },
  });
  const ran: string[] = [];
  const query = (name: string, ms: number) =>
    source.subscribe(["t"], () => {
      ran.push(name);
      clock += ms;
    });
  query("slow", 10);
  query("fast", 1);
  const apply = () => {
    for (const l of listeners) l(new Set(["t"]));
  };
  // Unknown costs: in order; the slow one fills the slice, the fast one runs after a yield.
  apply();
  queued.shift()?.();
  expect(ran).toEqual(["slow"]);
  expect(queued).toHaveLength(1);
  queued.shift()?.();
  expect(ran).toEqual(["slow", "fast"]);
  // Known costs: the fast one first.
  ran.length = 0;
  apply();
  queued.shift()?.();
  queued.shift()?.();
  expect(ran).toEqual(["fast", "slow"]);
  expect(queued).toHaveLength(0);
});
