// The phone holds its live-query re-runs while a first sync runs and runs them once when it ends.
import { createRerunScheduler } from "@cashu/store-react/local";
import { holdRerunsDuringFirstSync } from "./rerunHold";
import type { VaultSyncStatus } from "./vaultEngine";

function fakeSession(initial: Partial<VaultSyncStatus>) {
  let status: VaultSyncStatus = {
    vault: "v",
    phase: "ready",
    syncing: false,
    remote: true,
    unpushed: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch: Partial<VaultSyncStatus>) {
      status = { ...status, ...patch };
      for (const l of [...listeners]) l();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

it("holds re-runs during a first sync pass and runs them once when it ends", () => {
  const a = fakeSession({ phase: "receiving" });
  const b = fakeSession({ phase: "ready" });
  const q = createRerunScheduler({ schedule: (run) => run() });
  let runs = 0;
  let notify: (touched: ReadonlySet<string>) => void = () => {};
  q.wrap({
    read: () => [],
    tablesRead: () => new Set(),
    subscribe: (_t, l) => {
      notify = l;
      return () => {};
    },
  }).subscribe(["t"], () => {
    runs += 1;
  });
  const stop = holdRerunsDuringFirstSync(q, [a, b]);
  // Not syncing yet: a part applied re-runs at once.
  notify(new Set(["t"]));
  expect(runs).toBe(1);
  a.set({ syncing: true });
  for (let i = 0; i < 5; i++) notify(new Set(["t"]));
  expect(runs).toBe(1);
  // Another vault's ordinary pass changes nothing while the first sync runs.
  b.set({ syncing: true });
  b.set({ syncing: false });
  expect(runs).toBe(1);
  a.set({ phase: "ready", syncing: false });
  expect(runs).toBe(2);
  // An ordinary pass is not held.
  a.set({ syncing: true });
  notify(new Set(["t"]));
  expect(runs).toBe(3);
  stop();
  expect(a.listeners + b.listeners).toBe(0);
});

it("releases its hold when stopped during a first sync", () => {
  const a = fakeSession({ phase: "receiving", syncing: true });
  const queued: (() => void)[] = [];
  const q = createRerunScheduler({ schedule: (run) => queued.push(run) });
  const stop = holdRerunsDuringFirstSync(q, [a]);
  let runs = 0;
  let notify: (touched: ReadonlySet<string>) => void = () => {};
  q.wrap({
    read: () => [],
    tablesRead: () => new Set(),
    subscribe: (_t, l) => {
      notify = l;
      return () => {};
    },
  }).subscribe(["t"], () => {
    runs += 1;
  });
  notify(new Set(["t"]));
  expect(queued).toHaveLength(0);
  stop();
  while (queued.length > 0) queued.shift()?.();
  expect(runs).toBe(1);
});
